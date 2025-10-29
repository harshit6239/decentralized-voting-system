const fs = require("fs");
const path = require("path");
const { generateKeyPairSync, createSign, createVerify } = require("crypto");

const { resolved } = require("../common/config");
const { ensureDir, writeJson, readJson, nowISO } = require("../common/utils");

const LEDGER_PRIVATE_FILENAME = "ledger-sign-priv.json";
const LEDGER_PUBLIC_FILENAME = "ledger-sign-pub.json";
const SIGNING_ALGORITHM = "RSA-SHA256";

const ledgerPrivateKeyPath = path.join(
    resolved.KEYS_DIR,
    LEDGER_PRIVATE_FILENAME
);
const ledgerPublicKeyPath = path.join(
    resolved.KEYS_DIR,
    LEDGER_PUBLIC_FILENAME
);

const ensureLedgerKeyDirs = () => {
    ensureDir(ledgerPrivateKeyPath);
    ensureDir(ledgerPublicKeyPath);
};

const createLedgerKeys = () => {
    ensureLedgerKeyDirs();

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const createdAt = nowISO();

    writeJson(ledgerPrivateKeyPath, {
        type: "rsa",
        algorithm: SIGNING_ALGORITHM,
        format: "pem",
        key: privateKey,
        createdAt,
    });

    writeJson(ledgerPublicKeyPath, {
        type: "rsa",
        algorithm: SIGNING_ALGORITHM,
        format: "pem",
        key: publicKey,
        createdAt,
    });

    return {
        privateKeyPath: ledgerPrivateKeyPath,
        publicKeyPath: ledgerPublicKeyPath,
    };
};

const ensureLedgerKeys = () => {
    if (
        !fs.existsSync(ledgerPrivateKeyPath) ||
        !fs.existsSync(ledgerPublicKeyPath)
    ) {
        return createLedgerKeys();
    }

    return {
        privateKeyPath: ledgerPrivateKeyPath,
        publicKeyPath: ledgerPublicKeyPath,
    };
};

const loadLedgerPrivateKey = () => {
    if (!fs.existsSync(ledgerPrivateKeyPath)) {
        throw new Error(
            "Ledger private key missing; run ensureLedgerKeys first."
        );
    }

    const data = readJson(ledgerPrivateKeyPath);
    return data.key;
};

const loadLedgerPublicKey = () => {
    if (!fs.existsSync(ledgerPublicKeyPath)) {
        throw new Error(
            "Ledger public key missing; run ensureLedgerKeys first."
        );
    }

    const data = readJson(ledgerPublicKeyPath);
    return data.key;
};

const signReceipt = (receipt) => {
    const privateKey = loadLedgerPrivateKey();
    const signer = createSign("sha256");
    const payload = JSON.stringify(receipt);
    signer.update(payload);
    signer.end();
    return signer.sign(privateKey, "base64");
};

const verifyReceiptSignature = (receipt, signature) => {
    const publicKey = loadLedgerPublicKey();
    const verifier = createVerify("sha256");
    const payload = JSON.stringify(receipt);
    verifier.update(payload);
    verifier.end();
    return verifier.verify(publicKey, signature, "base64");
};

module.exports = {
    ensureLedgerKeys,
    createLedgerKeys,
    loadLedgerPrivateKey,
    loadLedgerPublicKey,
    signReceipt,
    verifyReceiptSignature,
    ledgerPrivateKeyPath,
    ledgerPublicKeyPath,
    SIGNING_ALGORITHM,
};
