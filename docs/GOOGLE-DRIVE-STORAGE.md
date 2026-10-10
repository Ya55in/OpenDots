# Space storage and attachments

Open a Space and choose **Files & storage**. Local attachments work immediately. Connecting Google Drive creates **OpenDots / Space name / Dot name** for each Dot with access to that Space. Stable folder identifiers prevent duplicate folders on retries; creating another Dot is picked up by **Ensure Dot folders** or its first upload.

Each Space connects independently and can use a different Google account. Dots can search/read only their own files inside their currently authorized Spaces. Owner-authenticated settings can browse all Dot folders. Existing imported knowledge archives and Space pages remain intact; connecting Drive changes the destination of new files and file memories, and does not automatically move older local files or migration ZIPs.

## Google setup

1. In one Google Cloud project, enable the **Google Drive API** and **Google Picker API**.
2. Configure the OAuth consent screen, audience and test users (if using Testing). Request only `https://www.googleapis.com/auth/drive.file`. Google may expire refresh tokens for external apps in Testing; publish the consent app for durable use when appropriate.
3. Create a **Web application** OAuth client. Authorized JavaScript origin: your HTTPS OpenDots origin. Redirect URI: `https://YOUR-OPENDOTS-HOST/storage/google/callback` (also displayed in the UI).
4. Create a Picker API key, restrict it to the Google Picker API and the exact OpenDots website's HTTP referrers. Use the same Cloud project's **numeric project number**, not its display name or project ID.
5. In **Files & storage → Google app setup**, save the client ID, client secret, Picker key and project number. Then choose **Connect Google Drive** and finish Google's consent screen for that Space.

Alternatively configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`, and `GOOGLE_PROJECT_NUMBER` as runtime secrets. UI settings override those four values together. `APP_ORIGIN` must be the canonical HTTPS app origin. OAuth redirects use its first origin, never an incoming Host header.

Set a stable `STORAGE_ENCRYPTION_KEY` (at least 24 random characters) before first connection. Without it, a sufficiently long `OWNER_TOKEN` is used as the encryption source. **Keep this source stable and backed up with the database**: changing it makes existing encrypted Google credentials unreadable. No credentials are written to the repository. Client secrets and refresh tokens are AES-256-GCM encrypted in SQLite and never returned to the browser. Google's Picker needs a short-lived `drive.file` access token in the owner-authenticated browser; it is not stored in browser storage. OAuth uses PKCE plus a short-lived, one-use state bound to an HttpOnly same-site browser cookie.

Official setup: https://developers.google.com/workspace/drive/picker/guides/web-picker and https://developers.google.com/identity/protocols/oauth2/web-server.

## Conversation attachments

The paperclip opens **My computer**, **Google Drive**, and previously saved Dot files. Choose up to 10 files per batch, 25 MB per file. Uploads use bounded, repeat-safe chunks. They are saved to the Dot's storage when uploaded/selected, then included in the next message as references. Removing a chip removes it from that message, not from the saved file library. Drive selections are copied into the Dot's folder; originals are not moved or modified.

OpenDots stores original local uploads privately in SQLite. With Drive connected, originals live in Drive and only searchable text/metadata are cached locally. Text/Markdown/CSV/JSON, PDFs and Office XML formats (DOCX/XLSX/PPTX) are extracted. Native Google Docs, Sheets and Slides are exported for text extraction. Extracts are limited to 200,000 characters; PDFs to 200 pages. Office extraction is a text view, not a spreadsheet calculation engine. Images, scans, encrypted or unsupported files remain stored with an honest extraction status. No OCR/transcription is claimed.

`search_files` and `read_file` let a Dot use these files across conversations. Extracted content is a snapshot; **Refresh** or `read_file(refresh: true)` rereads a current Drive file. `save_file_memory` writes sourced, dated Markdown memory to that Dot's configured folder. Imported historical HIBA knowledge remains available separately through `search_knowledge`/`read_knowledge`.

Disconnecting stops Drive access and leaves originals and cached text intact. Reconnecting the same Google identity restores access to its previously stored originals. A different Google identity cannot claim them. To revoke Google's grant entirely, remove the app in Google Account permissions; this may affect every Space using that Google account. Files never receive public sharing permissions from OpenDots.
