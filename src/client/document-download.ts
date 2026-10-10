export function fileDownloadPath(href: string | undefined) {
  return href && /^\/api\/spaces\/[\w-]+\/files\/[\w-]+\/download$/.test(href)
    ? href
    : null;
}
export async function downloadDocument(path: string, fallbackName: string) {
  if (!fileDownloadPath(path)) throw new Error('Invalid document link.');
  const { authHeaders } = await import('./api');
  const response = await fetch(path, { headers: authHeaders() });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? 'Download failed.');
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  const encoded = (response.headers.get('content-disposition') ?? '').split(
    "filename*=UTF-8''",
  )[1];
  a.download = encoded ? decodeURIComponent(encoded) : fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
