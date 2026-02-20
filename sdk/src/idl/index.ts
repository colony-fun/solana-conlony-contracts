import type { Idl } from "@coral-xyz/anchor";
import ColonyIDL from "./colony.json";

export type Colony = {
  address: string;
  metadata: {
    name: string;
    version: string;
    spec: string;
    description: string;
  };
  instructions: {
    name: string;
    discriminator: number[];
    accounts: {
      name: string;
      writable?: boolean;
      signer?: boolean;
      address?: string;
      pda?: {
        seeds: { kind: string; value: number[] }[];
      };
    }[];
    args: { name: string; type: string }[];
  }[];
  accounts: {
    name: string;
    discriminator: number[];
  }[];
  errors: {
    code: number;
    name: string;
    msg: string;
  }[];
  types: {
    name: string;
    type: {
      kind: string;
      fields: { name: string; type: string }[];
    };
  }[];
};

export const IDL = ColonyIDL as Colony & Idl;
export const PROGRAM_ID = ColonyIDL.address;
