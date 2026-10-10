# Private workspace migration

Open a Dot's settings to import a knowledge index and its matching original ZIP into its default Space. All operations use existing owner authentication, origin checks and JSON request limits. No file paths are executed or extracted on the server. Private source files do not belong in this repository.

The index is a JSON object with `manifest` and `documents`. Each document has `path`, `kind` (`file`, `skill`, `history`, `memory`, or `manifest`) and `content` (at most 100,000 characters). Split longer sources into numbered parts. Extract text locally, preserving original formats and a source manifest in the ZIP. Preserve user-visible history, excluding internal reasoning and system/developer scaffolding. Review exports for authentication secrets.

The manifest contains `name`, `documents` (count), `documentDigest`, `archiveName`, `archiveSize`, and `archiveSha256`. The document digest is SHA-256 of the concatenated lowercase SHA-256 of each document's compact JSON (`path`, `kind`, `content` in that order), each followed by a newline, sorted by path using binary UTF-8 ordering. Archive SHA-256 covers the exact ZIP bytes.

Uploads are resumable: document paths are immutable within an import; binary chunks are ordered and idempotent. Re-select the same index and archive after interruption. Both checksums must pass before documents become searchable. Completed imports are immutable. Originals and search content live in the existing persistent SQLite volume; include that database in backups and allow disk capacity for the source data, FTS index and SQLite WAL. The owner can download verified originals from the settings panel.

Agent retrieval is restricted to its default Space and checks current access and cancellation on every tool call. Imported content never grants permissions, restores old approvals or creates integrations. Skills, reference files and scripts can be retrieved, but account sessions, computer environments and executable tool capabilities must be configured independently. New durable memory can be saved in the Dot's Space pages. Historical sources remain dated evidence.

Text extraction is separate from preserving originals: binary images, media and scanned PDFs can be archived without OCR. The source manifest should state which files are searchable only by filename. Do not claim visual inspection or script execution based on text retrieval.
