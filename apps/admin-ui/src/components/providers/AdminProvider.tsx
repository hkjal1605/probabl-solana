"use client";
import { Buffer } from "buffer";
import { Toaster } from "@conditional-stocks/ui-kit/sonner";
import { ThemeProvider } from "@conditional-stocks/ui-kit/theme";
import { TooltipProvider } from "@conditional-stocks/ui-kit/tooltip";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { createContext,useContext,useState,useEffect,useRef,type ReactNode } from "react";
import { PublicKey,type VersionedTransaction } from "@solana/web3.js";
import { SolanaClient,assertSignInChallenge } from "@conditional-stocks/solana-client";
import { preflightAdmin,type AdminTransaction } from "@conditional-stocks/solana-client/admin";
import bs58 from "bs58";
import { adminConfig } from "@/config/protocol";
import { requestJson,SESSION_EXPIRED_EVENT } from "@/lib/admin-api";
export type { AdminTransaction };
interface Provider {
  publicKey:PublicKey|null;connect():Promise<{publicKey:PublicKey}>;disconnect():Promise<void>;
  signMessage(message:Uint8Array,encoding?:string):Promise<{signature:Uint8Array}>;
  signTransaction(transaction:VersionedTransaction):Promise<VersionedTransaction>;
  on?(event:string,callback:()=>void):void;removeListener?(event:string,callback:()=>void):void;
}
declare global{interface Window{solana?:Provider;phantom?:{solana?:Provider};solflare?:Provider}}
const wallet=()=>{const p=window.phantom?.solana??window.solflare??window.solana;if(!p)throw new Error("Open a Solana wallet such as Phantom or Solflare.");return p;};
interface AdminSession {
  account:string|null;token:string|null;chainId:number|null;signing:boolean;role:"operator"|"blocked"|"unverified";
  connect():Promise<void>;disconnect():void;ensureNetwork():Promise<void>;authenticate():Promise<void>;
  captureContext():()=>void;sendTransaction(transaction:AdminTransaction):Promise<string>;
}
const Context=createContext<AdminSession|null>(null);
export function AdminProvider({children}:{children:ReactNode}){
  const [queryClient]=useState(()=>new QueryClient({defaultOptions:{queries:{refetchOnWindowFocus:false,retry:1,staleTime:5000}}}));
  const [account,setAccount]=useState<string|null>(null),[token,setToken]=useState<string|null>(null),
    [chainId,setChainId]=useState<number|null>(null),[signing,setSigning]=useState(false),[operators,setOperators]=useState<string[]>([]);
  const generation=useRef(0),identity=useRef<string|null>(null),pending=useRef(false),session=useRef<string|null>(null);
  const clear=()=>{session.current=null;setToken(null);queryClient.clear();};
  useEffect(()=>{
    let p:Provider;try{p=wallet();}catch{return;}
    const changed=()=>{generation.current++;identity.current=p.publicKey?.toBase58()??null;setAccount(identity.current);setChainId(null);clear();};
    const expired=(e:Event)=>{if((e as CustomEvent).detail===session.current){generation.current++;clear();}};
    p.on?.("accountChanged",changed);p.on?.("disconnect",changed);window.addEventListener(SESSION_EXPIRED_EVENT,expired);
    return()=>{generation.current++;p.removeListener?.("accountChanged",changed);p.removeListener?.("disconnect",changed);window.removeEventListener(SESSION_EXPIRED_EVENT,expired);};
  },[queryClient]);
  const captureContext=()=>{const revision=generation.current,owner=identity.current,priorSession=session.current;
    return()=>{if(revision!==generation.current||identity.current!==owner||wallet().publicKey?.toBase58()!==owner||session.current!==priorSession)throw new Error("Operator wallet or session changed; review again.");};};
  const ensureNetwork=async()=>{const client=new SolanaClient(adminConfig);await client.assertNetwork();const cfg=await client.configAccount();
    setOperators([cfg.admin,cfg.roles.market_admin,cfg.roles.resolution_admin,cfg.roles.guardian].map(k=>k.toBase58()));setChainId(1);};
  const connect=async()=>{if(pending.current)throw new Error("A wallet request is pending");pending.current=true;
    const revision=generation.current;
    try{const result=await wallet().connect();if(revision!==generation.current)throw new Error("Wallet changed during connection");
      identity.current=result.publicKey.toBase58();generation.current++;setAccount(identity.current);clear();await ensureNetwork();
    }finally{pending.current=false;}};
  const disconnect=()=>{generation.current++;identity.current=null;setAccount(null);setChainId(null);clear();void wallet().disconnect().catch(()=>{});};
  const authenticate=async()=>{
    const owner=identity.current;if(!owner)throw new Error("Connect an operator wallet first.");
    if(pending.current)throw new Error("A wallet request is pending");pending.current=true;setSigning(true);
    const check=captureContext();
    try{await ensureNetwork();check();
      const challenge=await requestJson<{challengeId:string;message:string}>("/api/gateway/auth/challenge",{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({address:owner,origin:window.location.origin})});
      assertSignInChallenge(challenge,owner,adminConfig,window.location.origin);check();
      const signed=await wallet().signMessage(new TextEncoder().encode(challenge.message),"utf8");check();
      const result=await requestJson<{token:string}>("/api/gateway/auth/verify",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({address:owner,challengeId:challenge.challengeId,signature:bs58.encode(signed.signature)})});check();
      session.current=result.token;setToken(result.token);
    }finally{pending.current=false;setSigning(false);}
  };
  const sendTransaction=async(transaction:AdminTransaction)=>{
    if(!identity.current||!session.current)throw new Error("Sign in first.");
    if(transaction.from!==identity.current)throw new Error("Wallet is not the reviewed authority");
    if(pending.current)throw new Error("A wallet request is pending");pending.current=true;setSigning(true);
    const check=captureContext();
    try{const client=new SolanaClient(adminConfig),built=await preflightAdmin(client,transaction);check();
      const reviewed=Buffer.from(built.transaction.message.serialize()),signed=await wallet().signTransaction(built.transaction);check();
      if(!reviewed.equals(Buffer.from(signed.message.serialize())))throw new Error("Wallet changed the reviewed instruction bundle");
      const signature=await client.connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:2});
      const result=await client.connection.confirmTransaction({signature,blockhash:built.blockhash,lastValidBlockHeight:built.lastValidBlockHeight},"confirmed");
      if(result.value.err)throw new Error("Transaction failed and its changes rolled back");
      return signature;
    }finally{pending.current=false;setSigning(false);}
  };
  const role=account?(operators.includes(account)?"operator":"blocked"):"unverified";
  return <ThemeProvider><QueryClientProvider client={queryClient}><Context.Provider value={{account,token,chainId,signing,role,connect,disconnect,ensureNetwork,authenticate,captureContext,sendTransaction}}>
    <TooltipProvider delayDuration={250}>{children}<Toaster richColors position="bottom-right"/></TooltipProvider>
  </Context.Provider></QueryClientProvider></ThemeProvider>;
}
export function useAdmin(){const value=useContext(Context);if(!value)throw new Error("AdminProvider required");return value;}
