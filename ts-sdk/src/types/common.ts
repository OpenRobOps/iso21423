export type Uuid = string;

export type IsoTimestamp = string;

export interface SoftwareVersion {
  moduleName: string;
  moduleVersion: string;
}

export interface SupportVendorContactInformation {
  name: string;
  phone?: string;
  address?: string;
  email?: string;
}
