"use client";
import { Buffer } from "buffer";
import { createContext,useContext,useState,useEffect,useRef,type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PublicKey,type VersionedTransaction } from "@solana/web3.js";
import { SolanaClient,assertSignInChallenge,type Envelope } from "@conditional-stocks/solana-client";
import bs58 from "bs58";
import { protocolConfig } from "@/config/protocol";
import { requestJson } from "@/lib/api/client";

interface SolanaWallet {
  publicKey:PublicKey|null;
  connect():Promise<{publicKey:PublicKey}>;
  disconnect():Promise<void>;
  signMessage(message:Uint8Array,encoding?:string):Promise<{signature:Uint8Array}>;
  signTransaction(transaction:VersionedTransaction):Promise<VersionedTransaction>;
  on?(event:string,callback:()=>void):void;
  removeListener?(event:string,callback:()=>void):void;
}
declare global {interface Window {solana?:SolanaWallet;phantom?:{solana?:SolanaWallet};solflare?:SolanaWallet}}
const provider=()=>{const p=window.phantom?.solana??window.solflare??window.solana;if(!p)throw new Error("Open a Solana wallet such as Phantom or Solflare.");return p;};
interface WalletValue {
  account:string|null;chainId:number|null;sessionToken:string|null;error:string|null;
  status:"idle"|"connecting"|"connected"|"signing"|"error";
  connect():Promise<void>;disconnect():void;ensureNetwork():Promise<void>;authenticate():Promise<string>;
  invalidateSession():void;sendTransaction(transaction:{to:string;data:string;value?:string}):Promise<string>;
}
const Context=createContext<WalletValue|null>(null);
export function WalletProvider({children}:{children:ReactNode}) {
  const cache=useQueryClient(),[account,setAccount]=useState<string|null>(null),[chainId,setChainId]=useState<number|null>(null),
    [sessionToken,setSession]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[status,setStatus]=useState<WalletValue["status"]>("idle");
  const generation=useRef(0),identity=useRef<string|null>(null),pending=useRef(false);
  useEffect(()=>{
    let p:SolanaWallet;try{p=provider();}catch{return;}
    const changed=()=>{generation.current++;identity.current=p.publicKey?.toBase58()??null;setAccount(identity.current);setSession(null);setChainId(null);cache.clear();setStatus(identity.current?"connected":"idle");};
    p.on?.("accountChanged",changed);p.on?.("disconnect",changed);
    return()=>{generation.current++;p.removeListener?.("accountChanged",changed);p.removeListener?.("disconnect",changed);};
  },[cache]);
  const capture=()=>{const revision=generation.current,owner=identity.current;if(!owner)throw new Error("Connect a wallet first.");
    return()=>{if(revision!==generation.current||provider().publicKey?.toBase58()!==owner)throw new Error("Wallet changed. Review the action again.");};};
  const ensureNetwork=async()=>{await new SolanaClient(protocolConfig).assertNetwork();setChainId(protocolConfig.chainId);};
  const connect=async()=>{setStatus("connecting");setError(null);try{
    const result=await provider().connect();generation.current++;identity.current=result.publicKey.toBase58();setAccount(identity.current);setSession(null);
    await ensureNetwork();setStatus("connected");
  }catch(e){setError(e instanceof Error?e.message:"Wallet connection failed");setStatus("error");throw e;}};
  const disconnect=()=>{generation.current++;identity.current=null;setAccount(null);setSession(null);setChainId(null);setStatus("idle");cache.clear();void provider().disconnect();};
  const authenticate=async()=>{
    if(pending.current)throw new Error("A wallet request is already in progress.");
    const check=capture(),owner=identity.current!;pending.current=true;setStatus("signing");
    try{await ensureNetwork();check();
      const challenge=await requestJson<{challengeId:string;message:string}>("/api/gateway/auth/challenge",{body:{address:owner,origin:window.location.origin}});
      assertSignInChallenge(challenge,owner,protocolConfig,window.location.origin);
      check();const signed=await provider().signMessage(new TextEncoder().encode(challenge.message),"utf8");check();
      const result=await requestJson<{token:string}>("/api/gateway/auth/verify",{body:{address:owner,challengeId:challenge.challengeId,signature:bs58.encode(signed.signature)}});
      check();setSession(result.token);return result.token;
    }finally{pending.current=false;setStatus(identity.current?"connected":"idle");}
  };
  const sendTransaction=async(value:{to:string;data:string;value?:string})=>{
    if(pending.current)throw new Error("A wallet request is already in progress.");
    const check=capture(),owner=new PublicKey(identity.current!);pending.current=true;
    try{const client=new SolanaClient(protocolConfig),built=await client.prepareTransaction(owner,{...value,value:value.value??"0"}as Envelope);
      check();const original=Buffer.from(built.transaction.message.serialize());
      const signed=await provider().signTransaction(built.transaction);check();
      if(!Buffer.from(signed.message.serialize()).equals(original))throw new Error("Wallet changed the reviewed transaction.");
      const signature=await client.connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:2});
      const confirmed=await client.connection.confirmTransaction({signature,blockhash:built.blockhash,lastValidBlockHeight:built.lastValidBlockHeight},"confirmed");
      if(confirmed.value.err)throw new Error("Transaction failed. Its state changes were rolled back.");
      return signature;
    }finally{pending.current=false;}
  };
  return <Context.Provider value={{account,chainId,sessionToken,error,status,connect,disconnect,ensureNetwork,authenticate,
    invalidateSession:()=>setSession(null),sendTransaction}}>{children}</Context.Provider>;
}
export function useWallet(){const value=useContext(Context);if(!value)throw new Error("WalletProvider is required");return value;}
