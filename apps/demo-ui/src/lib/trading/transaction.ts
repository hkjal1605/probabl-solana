export interface IssuerTransfer {
  mint: string;
  gross: string;
  fee: string;
  minimumReceived: string;
}

/** A reviewed protocol action, ready for the wallet to sign and submit. */
export interface ProtocolTransaction {
  summary: string;
  issuerTransfers?: IssuerTransfer[];
  execute(): string;
}

export const transaction = (
  summary: string,
  execute: () => string,
  issuerTransfers: IssuerTransfer[] = [],
): ProtocolTransaction => ({ summary, execute, issuerTransfers });
