# btp-voting-proto

Prototype platform exploring secure ballot handling, ledger services, and registration authority workflows using Express, SQLite, and cryptographic tooling.

## Prerequisites

-   Node.js 20 or later
-   npm

Install dependencies once:

```
npm install
```

## Reproducible demo (in-process)

The project ships with an end-to-end demo that runs entirely in-process—no external servers required. It creates a demo election, issues voter tokens, encrypts and records ballots, runs a tally, and performs an audit.

```
node scripts/demo_inprocess.js
```

The script prints the signed tally, audit report, and a JSON summary of generated artifacts for quick review.

## Cleanup utilities

Use either script to remove demo artifacts (ledger rows, tokens, ciphertexts, audit/tally files, and demo VVPAT snapshots):

-   Node (cross-platform):

    ```
    node scripts/cleanup.js
    ```

-   POSIX shell wrapper (macOS/Linux):

    ```
    chmod +x scripts/cleanup.sh
    ./scripts/cleanup.sh
    ```

Both scripts are idempotent; run them before or after the demo to ensure a pristine environment.

## File artifacts

During the demo the following locations receive generated data:

-   `data/ciphers/` – encrypted ballots (binary blobs)
-   `data/tokens/` – JWT token files issued by the RA
-   `data/ledger.jsonl` – append-only ledger log (one JSON object per line)
-   `data/tally-*.json` – signed tally reports
-   `data/audit-report-*.json` – audit results
-   `src/terminal_vvpats/*.json` – virtual VVPAT receipts tied to commitments (ballot choices only; voter identifiers are stripped and files are ignored by git)
-   SQLite database: `data/ledger.db`

The cleanup scripts remove the demo-specific rows and files listed above, recreating the necessary directories for subsequent runs.

## Testing

The Jest suite exercises core services, the in-process demo, and cleanup tooling:

```
npm test
```

All integration tests run locally without spawning HTTP servers.
