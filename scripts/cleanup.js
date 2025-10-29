#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { getDb, deleteElection } = require("../src/common/db");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const CIPHER_DIR = path.join(DATA_DIR, "ciphers");
const TOKENS_DIR = path.join(DATA_DIR, "tokens");
const LEDGER_LOG_PATH = path.join(DATA_DIR, "ledger.jsonl");
const TALLY_PREFIX = "tally-";
const AUDIT_PREFIX = "audit-report-";
const VVPAT_DIR = path.join(PROJECT_ROOT, "src", "terminal_vvpats");
const KEYS_DIR = path.join(PROJECT_ROOT, "src", "keys");

const DEFAULT_ELECTION_ID = "e-demo";

const safeRemove = (targetPath) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
};

const removeMatchingFiles = (rootDir, predicate) => {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const removed = [];
    for (const entry of fs.readdirSync(rootDir)) {
        const entryPath = path.join(rootDir, entry);
        if (predicate(entry, entryPath)) {
            safeRemove(entryPath);
            removed.push(entryPath);
        }
    }

    return removed;
};

const removePaths = (paths) => {
    const removed = [];
    for (const target of paths) {
        if (!target) {
            continue;
        }

        try {
            safeRemove(target);
            removed.push(target);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }

    return removed;
};

const cleanDemo = ({
    quiet = false,
    electionId = DEFAULT_ELECTION_ID,
} = {}) => {
    const db = getDb();
    const summary = {
        electionId,
        ledgerRowsCleared: 0,
        tokensCleared: 0,
        auditFilesRemoved: [],
        tallyFilesRemoved: [],
        cipherFilesRemoved: [],
        tokenFilesRemoved: [],
        vvpatFilesRemoved: [],
        ledgerLogEntriesRemoved: 0,
        keysDirEnsured: KEYS_DIR,
    };

    const log = quiet ? () => {} : console.log;

    let cipherRefs = [];
    let tokenIds = [];

    try {
        cipherRefs = db
            .prepare("SELECT cipherRef FROM ledger WHERE electionId = ?")
            .all(electionId)
            .map((row) => row.cipherRef)
            .filter(Boolean);
    } catch (error) {
        if (!/no such table/i.test(error.message)) {
            throw error;
        }
    }

    try {
        tokenIds = db
            .prepare("SELECT tokenId FROM tokens WHERE electionId = ?")
            .all(electionId)
            .map((row) => row.tokenId)
            .filter(Boolean);
    } catch (error) {
        if (!/no such table/i.test(error.message)) {
            throw error;
        }
    }

    try {
        summary.ledgerRowsCleared = db
            .prepare("DELETE FROM ledger WHERE electionId = ?")
            .run(electionId).changes;
    } catch (error) {
        if (!/no such table/i.test(error.message)) {
            throw error;
        }
    }

    try {
        summary.tokensCleared = db
            .prepare("DELETE FROM tokens WHERE electionId = ?")
            .run(electionId).changes;
    } catch (error) {
        if (!/no such table/i.test(error.message)) {
            throw error;
        }
    }

    try {
        deleteElection(electionId);
    } catch (error) {
        if (!/no such table/i.test(error.message)) {
            throw error;
        }
    }

    const cipherPaths = cipherRefs.map((ref) =>
        path.isAbsolute(ref) ? ref : path.resolve(PROJECT_ROOT, ref)
    );
    const tokenPaths = tokenIds.map((tokenId) =>
        path.join(TOKENS_DIR, `${tokenId}.jwt`)
    );

    summary.cipherFilesRemoved = removePaths(cipherPaths);
    summary.tokenFilesRemoved = removePaths(tokenPaths);
    summary.auditFilesRemoved = removeMatchingFiles(
        DATA_DIR,
        (entry, entryPath) =>
            entry.startsWith(`${AUDIT_PREFIX}${electionId}-`) &&
            fs.lstatSync(entryPath).isFile()
    );
    summary.tallyFilesRemoved = removeMatchingFiles(
        DATA_DIR,
        (entry, entryPath) =>
            entry.startsWith(`${TALLY_PREFIX}${electionId}-`) &&
            fs.lstatSync(entryPath).isFile()
    );

    summary.vvpatFilesRemoved = removeMatchingFiles(
        VVPAT_DIR,
        (entry, entryPath) => {
            if (!entry.endsWith(".json")) {
                return false;
            }

            try {
                const content = JSON.parse(fs.readFileSync(entryPath, "utf8"));
                return content?.ballotPlain?.electionId === electionId;
            } catch (error) {
                log(
                    `Skipping malformed VVPAT entry ${entryPath}: ${error.message}`
                );
                return false;
            }
        }
    );

    if (fs.existsSync(LEDGER_LOG_PATH)) {
        const lines = fs.readFileSync(LEDGER_LOG_PATH, "utf8").split(/\r?\n/);
        const kept = [];
        let removedCount = 0;

        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            try {
                const entry = JSON.parse(line);
                const entryElectionId =
                    entry.electionId || entry.receipt?.electionId || null;

                if (entryElectionId && entryElectionId === electionId) {
                    removedCount += 1;
                    continue;
                }

                kept.push(line);
            } catch (error) {
                log(`Skipping malformed ledger log entry: ${error.message}`);
                kept.push(line);
            }
        }

        if (removedCount > 0) {
            if (kept.length === 0) {
                safeRemove(LEDGER_LOG_PATH);
            } else {
                fs.writeFileSync(
                    LEDGER_LOG_PATH,
                    `${kept.join("\n")}\n`,
                    "utf8"
                );
            }
        }

        summary.ledgerLogEntriesRemoved = removedCount;
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(CIPHER_DIR, { recursive: true });
    fs.mkdirSync(TOKENS_DIR, { recursive: true });
    fs.mkdirSync(VVPAT_DIR, { recursive: true });
    fs.mkdirSync(KEYS_DIR, { recursive: true });

    return summary;
};

const main = () => {
    const quiet = process.argv.includes("--quiet");
    try {
        const summary = cleanDemo({ quiet });
        if (!quiet) {
            console.log("Demo artifacts cleaned:");
            console.log(JSON.stringify(summary, null, 2));
        }
    } catch (error) {
        console.error("Cleanup failed:", error);
        process.exitCode = 1;
    }
};

if (require.main === module) {
    main();
}

module.exports = {
    cleanDemo,
    DEFAULT_ELECTION_ID,
};
