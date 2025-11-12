# Secure E2E Voting Prototype - Deep Dive

> **Purpose:** This document offers an exhaustive implementation-level walkthrough of the voting prototype in this repository. It covers the problem motivation, solution architecture, component interactions, data schemas, cryptographic tooling, and the full ballot lifecycle. Treat it as the primary onboarding and analysis guide.

## 1. Problem Statement

Modern elections must guarantee voter privacy, prevent double voting, and remain openly auditable. Paper-based processes provide transparency but lack efficiency, while naive electronic approaches risk tampering and opacity. This project tackles the challenge of building a prototype that:

-   Protects ballot secrecy throughout the submission and tally pipeline.
-   Enforces strict single-use voting credentials tied to specific elections.
-   Maintains a verifiable ledger of cast ballots without revealing vote contents.
-   Supports risk-limiting audits and independent verification of the final tally.
-   Demonstrates these properties in an entirely local, reproducible environment.

## 2. Solution Overview

The prototype decomposes the election workflow into modular services and libraries:

1. **Registration Authority (RA):** Issues signed JWT tokens to eligible voters, embedding election metadata and expiration claims.
2. **Ledger Service:** Authenticates tokens, persists encrypted ballots, returns signed receipts, and exposes verification endpoints without ever storing voter or token identifiers alongside ciphertext.
3. **Tally and Audit Engine:** Decrypts ballots after the election closes, computes results, signs tally artifacts, and runs deterministic audits.
4. **Voter Toolkit:** Generates voter key material, encrypts ballots against election keys, submits to the ledger, and records anonymized VVPAT receipts.
5. **Demo and Cleanup Scripts:** Provide deterministic end-to-end flows, artifact inspection, and environment reset.

The design enforces separation of duties, cryptographic linking between steps, and persistent transparent records for review.

## 3. Architecture Overview

```
┌────────────────────┐        Token JWT        ┌─────────────────────┐
│ Registration Auth. │ ─────────────────────▶ │ Voter Client / CLI │
└────────────────────┘                         └─────────────────────┘
           │                                              │
           │ Ledger log &                                 │ Encrypted ballot + metadata
           ▼ commit ledger entries                        ▼
┌────────────────────┐  Signed receipts & ledger outputs  ┌─────────────────────┐
│ Ledger Service     │──────────────────────────────────▶│ Ledger Log (JSONL)  │
└────────┬───────────┘                                    └─────────────────────┘
         │ Cipher refs
         ▼
 ┌────────────────────┐
 │ Cipher Store       │
 └────────────────────┘
         │
         ▼  Decrypt, tally, audit
┌────────────────────┐
│ Tally & Audit      │
│ Engine             │
└────────────────────┘
```

**Key linkages:**

-   The ledger verifies JWTs using the RA public key, while voters validate ledger receipts through the ledger public key.
-   Voters encrypt ballots with election public keys produced by internal key management.
-   SQLite and filesystem artifacts under `data/` and `src/terminal_vvpats/` form the persistence layer shared across components.

## 4. Component Responsibilities

### 4.1 Registration Authority (`src/ra/`)

-   **`tokenService.js`**

    -   Generates RSA signing keys (`RS256`) for token issuance and stores them under `src/keys/` when absent.
    -   `issueToken({ electionId, voterId })` loads election metadata from SQLite, creates a JWT with `exp`, persists the token row, and writes a `.jwt` file to `data/tokens/`.
    -   Exposes `loadPublicKey()` for the ledger to verify incoming tokens.

-   **`server.js`**
    -   Express app exposing `/issue-token` (POST) and `/token/:tokenId` (GET).
    -   Handles validation, logging via Pino, and friendly error surfaces.

### 4.2 Ledger (`src/ledger/`)

-   **`server.js`**

    -   `/submit`: Validates payloads, verifies JWT signatures, ensures election alignment, marks tokens as used, inserts ledger rows, writes cipher blobs, signs receipts, and appends JSONL ledger entries with metadata (nonces, receipts, timestamps—no token identifiers).
    -   `/verify/:receiptId`: Fetches ledger entries, retrieves stored signatures, and confirms authenticity using the ledger public key.
    -   `/tally`: Delegates to the tally engine with optional admin token guard.
    -   `/verify-token/:tokenId` and `/verify-receipt/:receiptId`: Convenience checks for observers.

-   **`signing.js`**

    -   Manages RSA keypair (`RSA-SHA256`) dedicated to signing receipts and tally artifacts.
    -   `signReceipt` and `verifyReceiptSignature` provide cryptographic anchoring for receipts.

-   **`tally.js`**

    -   Confirms the election has ended, loads ledger rows, retrieves nonces from the ledger log, decrypts ballots using the election private key, aggregates counts, and writes a signed tally file (`data/tally-<id>-<timestamp>.json`).

-   **`verify.js`**
    -   Utility logic for token and receipt verification endpoints.

### 4.3 Common Layer (`src/common/`)

-   **`db.js`**

    -   Configures SQLite with three tables and WAL journaling for concurrency.
    -   Provides prepared statements for elections, tokens, and ledger rows plus helper functions (insert, select, list, markUsed, delete).

-   **`crypto.js`**

    -   Uses TweetNaCl for X25519 (encryption) and Ed25519 (signatures).
    -   Implements `genKeypair`, `encryptWithPublicKey`, `decryptWithPrivateKey`, `computeCommitment`, and signature primitives.

-   **`utils.js`**
    -   Filesystem utilities (`ensureDir`, `readJson`, `writeJson`) and time/base64 helpers.

### 4.4 Voter Toolkit (`src/voter/`)

-   **`voter.js`**

    -   Generates voter-specific key material, constructs ballot objects, encrypts them with election public keys, submits to ledger (`axios.post` with retryable errors), and records anonymized VVPAT JSON files.
    -   Provides `DEFAULT_LEDGER_URL`, `recordVvpat`, and key-path helpers consumed by CLI and tests.

-   **`cli.js`**
    -   Implements commands such as `cast`, `generate-keys`, and `show-receipt` using the toolkit functions.

### 4.5 Demo and Maintenance Scripts (`scripts/`)

-   **`demo_inprocess.js`**

    -   Executes the full election lifecycle in-memory: cleanup, key generation, election insertion, token issuance, ledger submissions, VVPAT creation, tally, audit, and artifact summary return.
    -   Powers integration tests and acts as a quick start demonstration.

-   **`cleanup.js` / `cleanup.sh`**
    -   Remove election-specific database rows, ciphertexts, token files, VVPATs, ledger log lines, and tally/audit outputs.
    -   Idempotent and parameterized by election ID for targeted cleanup.

## 5. Data Model Details

### 5.1 SQLite Schema

| Table       | Columns                                                                                                  | Description                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `elections` | `id` (PK), `title`, `start_iso`, `end_iso`, `choices_json`                                               | Election catalog with scheduling and ballot options.        |
| `tokens`    | `tokenId` (PK), `electionId`, `voterId`, `tokenJwt`, `used` (0/1), `issuedAt`                            | Registration authority issuance records and usage tracking. |
| `ledger`    | `"index"` (PK AUTOINCREMENT), `commitment` (UNIQUE), `cipherRef`, `electionId`, `timestamp`, `receiptId` | Persistent record of encrypted ballots and metadata.        |

### 5.2 Filesystem Artifacts

-   `data/ciphers/<commitment>.bin` - sealed ballot payloads (binary), stored with absolute references for reliability.
-   `data/tokens/<tokenId>.jwt` - signed voter tokens for distribution or audit.
-   `data/ledger.jsonl` - append-only audit log with nonces, receipts, signatures, and storage metadata (no token identifiers are recorded).
-   `data/tally-<electionId>-<timestamp>.json` - signed tally outputs containing totals and cryptographic signatures.
-   `data/audit-report-<electionId>-<timestamp>.json` - audit documentation and sample results.
-   `src/terminal_vvpats/<commitment>.json` - VVPAT snapshots linking anonymized ballot choices to signed receipts (directory retained via `.gitkeep`; JSON artifacts are ignored by git).
-   `src/keys/` - RA, ledger, election, and voter key files encoded as JSON for portability.

## 6. Cryptographic Toolkit

1. **JWT Tokens (RA):** RSA 2048-bit with `RS256`. Claims include `tokenId`, `electionId`, `voterId`, `exp`, and `electionEndsAt`.
2. **Ballot Encryption:** TweetNaCl sealed box with ephemeral key pairs and 24-byte nonces. Commitments computed via SHA-256 over ciphertext and nonce.
3. **Ledger Receipts:** RSA-SHA256 signatures over receipt JSON, persisted alongside ledger log entries and returned to voters.
4. **VVPAT Files:** Store anonymized ballots (election + choice only), signed receipts, and timestamps, enabling external audits without exposing voter identity.
5. **Tally Decryption:** After the election window closes, ballots are decrypted using the election private key and logged nonces.
6. **Audit Sampling:** Deterministic pseudo-random selection seeded with the final ledger commitment, enabling reproducible risk-limiting audits.

## 7. Voting Flow Walkthrough

1. **Election Setup**

    - Officials run `genKeypair` to create election encryption/signing keys stored under `src/keys/`.
    - `generateSigningKeys` ensures RA RSA key material is available.
    - Election definition inserted into SQLite with start/end timestamps and choice list.

2. **Token Issuance**

    - RA `/issue-token` endpoint generates a JWT token per voter and persists the issuance record.
    - Tokens are saved to the filesystem and returned to voters for use in ballot submission.

3. **Ballot Preparation**

    - Voter constructs a ballot using `buildBallotPlain`, capturing election ID, voter ID, choice, and timestamp.
    - `encryptBallot` seals the ballot with the election public key, automatically omitting the voter identifier from the serialized payload so no stored artifact can reveal voter identity, while returning ciphertext, nonce, and commitment identifier.

4. **Ballot Submission**

    - Voter sends payload to ledger `/submit` with accompanying token.
    - Ledger verifies the JWT signature, confirms election alignment, checks the token is unused, and recomputes the commitment for integrity.
    - Token marked used, ledger row inserted, ciphertext written to disk, ledger log entry appended, receipt signed and returned.

5. **VVPAT Recording**

    - Clients call `recordVvpat` (embedded in CLI) to persist a JSON artifact containing the anonymized ballot (election + choice) and signed receipt.

6. **Tally Generation**

    - After `end_iso`, admin triggers `/tally` or runs the demo script to auto-close the election.
    - Tally engine decrypts ballots using stored nonces and election private key, aggregates choice counts, signs result, and writes tally file.

7. **Audit and Verification**
    - `auditElection` deterministically samples VVPATs, refetches corresponding ledger data, decrypts, and compares.
    - Outputs an audit report describing sample outcomes, pass/fail counts, and metadata.
    - Observers may call `/verify/:receiptId` or `/verify-token/:tokenId` to confirm inclusion and usage status respectively.

## 8. Testing Strategy

-   Jest test suites exercise cleanup, integration demo, ledger submission, RA issuance, tally decryption, audit workflows, crypto primitives, and voter CLI behavior.
-   Tests isolate shared state by namespacing election IDs, creating temporary cipher directories, and retrying runs on transient token contention.
-   `scripts/demo_inprocess.js` drives end-to-end verification and returns artifact lists for assertions.

## 9. Operational Notes

-   **Key storage:** Prototype stores JSON-encoded keys locally; production deployments should use secure hardware or managed key services.
-   **Transport security:** Runtime assumes local HTTP. Real systems require TLS, authentication, and potentially mutual TLS between services.
-   **Database:** SQLite is convenient for local demos. DAOs can be ported to PostgreSQL or another RDBMS with minimal refactoring.
-   **Hardening:** Add rate limiting, structured logging sinks, secret management, and continuous monitoring for tamper detection.
-   **Audit anchoring:** Ledger entries can be anchored externally (e.g., blockchain) for additional immutability guarantees.

## 10. Future Enhancements

-   Support multi-choice, ranked-choice, or approval voting by extending schema and tally logic.
-   Add voter registration and eligibility workflows ahead of token issuance.
-   Scale services horizontally with message queues and background workers for heavy load.
-   Introduce threshold cryptography or sharded key custody for election private keys.
-   Build observer dashboards for real-time ledger monitoring and audit visualization.

---

**Takeaway:** The repository demonstrates a full, audit-friendly electronic voting workflow with strong cryptographic guarantees and clear component boundaries. It provides a solid foundation for experimentation, education, and further research into secure digital elections.
