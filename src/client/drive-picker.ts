import { api } from './api';
type PickerData = { action: string; docs?: { id: string }[] };
interface Picker {
  setVisible(value: boolean): void;
  dispose(): void;
}
interface Builder {
  setAppId(v: string): Builder;
  setDeveloperKey(v: string): Builder;
  setOAuthToken(v: string): Builder;
  setOrigin(v: string): Builder;
  setTitle(v: string): Builder;
  addView(v: unknown): Builder;
  enableFeature(v: unknown): Builder;
  setCallback(cb: (v: PickerData) => void): Builder;
  build(): Picker;
}
interface GooglePicker {
  PickerBuilder: new () => Builder;
  DocsView: new () => { setIncludeFolders(v: boolean): unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
}
declare global {
  interface Window {
    gapi?: {
      load(
        name: string,
        options: {
          callback: () => void;
          onerror: () => void;
          timeout: number;
          ontimeout: () => void;
        },
      ): void;
    };
    google?: { picker?: GooglePicker };
  }
}
let loading: Promise<void> | undefined;
function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  if (!loading)
    loading = new Promise<void>((resolve, reject) => {
      const fail = () => {
        loading = undefined;
        reject(
          new Error(
            'Google Drive picker could not load. Check your connection and try again.',
          ),
        );
      };
      const init = () =>
        window.gapi?.load('picker', {
          callback: resolve,
          onerror: fail,
          timeout: 15000,
          ontimeout: fail,
        });
      if (window.gapi) {
        init();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => init();
      script.onerror = () => {
        script.remove();
        fail();
      };
      document.head.append(script);
    });
  return loading;
}
export async function pickDriveFiles(spaceId: string): Promise<string[]> {
  await loadPicker();
  const config = await api<{
    accessToken: string;
    apiKey: string;
    appId: string;
  }>(`/spaces/${spaceId}/storage/picker`, 'POST', {});
  const google = window.google!.picker!;
  return new Promise((resolve) => {
    const picker = new google.PickerBuilder()
      .setAppId(config.appId)
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(config.accessToken)
      .setOrigin(location.origin)
      .setTitle('Choose files to copy into this Dot’s folder')
      .addView(new google.DocsView().setIncludeFolders(true))
      .enableFeature(google.Feature.MULTISELECT_ENABLED)
      .setCallback((result) => {
        if (result.action === google.Action.PICKED) {
          picker.dispose();
          resolve((result.docs ?? []).map((d) => d.id));
        } else if (result.action === google.Action.CANCEL) {
          picker.dispose();
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
