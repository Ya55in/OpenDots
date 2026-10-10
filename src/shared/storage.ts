export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 512 * 1024;
export interface StoredFile {
  id: string;
  spaceId: string;
  dotId: string;
  threadId: string | null;
  name: string;
  mimeType: string;
  size: number;
  provider: 'local' | 'drive';
  driveId: string | null;
  textStatus: string;
  createdAt: number;
}
export interface StorageStatus {
  connected: boolean;
  email?: string;
  folderUrl?: string;
  configured: boolean;
  pickerReady: boolean;
  encryptionReady: boolean;
  redirectUri: string;
  clientId: string;
  projectNumber: string;
  hasClientSecret: boolean;
  hasPickerKey: boolean;
}
