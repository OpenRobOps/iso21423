import type { Uuid, IsoTimestamp } from './common.js';
import type { EntityType } from './constants.js';
import type { Point } from './ccs.js';

/** What an entity can do and, for fleet managers, which robots it manages (or, for a managed robot, who manages it). */
export interface Capabilities {
  provides: string[];
  accepts: { requests: string[] };
  manages?: Uuid[];
  managedBy?: Uuid;
}

export interface SoftwareVersion { moduleName: string; moduleVersion: string }

export interface AdditionalProperty { key: string; value: string }

export interface SupportVendorContactInformation {
  name: string; phone?: string; address?: string; email?: string;
}

/** Identity payload for an IMR (the robot itself). */
export interface ImrDetails {
  imrModel: string;
  imrSerialNumber: string;
  imrName?: string;                     // schema/example field, spec §3.1 (B2 in defects doc)
  imrFootprint: Point[];
  imrWorkingArea: Point[];
  imrHeight: number;
  softwareVersions: SoftwareVersion[];
  priority?: number;
  ratedSpeed?: number;
  supportedChargerTypes?: string[];
  supportVendorName?: string;
  supportVendorContactInformation?: string;
  visualThumbnailImage?: string;
  ratedLoad?: number;
  supportURL?: string;
  imrDocumentation?: string;
  payloadTypes?: string[];
  batteryType?: string;
  additionalProperties?: AdditionalProperty[];
}

/** Identity payload for an IMRFM (fleet manager). */
export interface ImrfmDetails {
  softwareVersions: SoftwareVersion[];
  imrfmModel?: string;
  supportVendorContactInf?: SupportVendorContactInformation;
  supportURL?: string;
  imrfmDocumentation?: string;
}

/** Wire shape of the retained identity message an entity publishes on connect. */
export interface EntityIdentity {
  id: Uuid;
  timestamp: IsoTimestamp;
  entityType: EntityType;
  manufacturerName: string;
  iso21423Version?: string;
  capabilities: Capabilities;
  details: ImrDetails | ImrfmDetails | Record<string, unknown>;
}
