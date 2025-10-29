const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const nacl = require("tweetnacl");
const naclUtil = require("tweetnacl-util");

const { KEYS_DIR, resolved } = require("./config");
const {
    readJson,
    writeJson,
    nowISO,
    toBase64,
    fromBase64,
} = require("./utils");

const KEY_ALGO_BOX = "x25519";
const KEY_ALGO_SIGN = "ed25519";

const keysRoot = resolved.KEYS_DIR;

const resolveKeyFile = (filePath) => {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }

    return path.resolve(keysRoot, filePath);
};

const ensureKeysDir = () => {
    fs.mkdirSync(keysRoot, { recursive: true });
};

const asUint8 = (input) => {
    if (input instanceof Uint8Array) {
        return input;
    }

    if (Buffer.isBuffer(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }

    if (Array.isArray(input)) {
        return Uint8Array.from(input);
    }

    throw new TypeError("Unable to convert input to Uint8Array");
};

const genKeypair = (name) => {
    ensureKeysDir();

    const boxKeyPair = nacl.box.keyPair();
    const signKeyPair = nacl.sign.keyPair();

    const timestamp = nowISO();

    const boxKeyPath = path.join(keysRoot, `${name}-${KEY_ALGO_BOX}.json`);
    const signKeyPath = path.join(keysRoot, `${name}-${KEY_ALGO_SIGN}.json`);

    writeJson(boxKeyPath, {
        name,
        type: KEY_ALGO_BOX,
        publicKey: toBase64(boxKeyPair.publicKey),
        secretKey: toBase64(boxKeyPair.secretKey),
        createdAt: timestamp,
    });

    writeJson(signKeyPath, {
        name,
        type: KEY_ALGO_SIGN,
        publicKey: toBase64(signKeyPair.publicKey),
        secretKey: toBase64(signKeyPair.secretKey),
        createdAt: timestamp,
    });

    return {
        [KEY_ALGO_BOX]: boxKeyPath,
        [KEY_ALGO_SIGN]: signKeyPath,
    };
};

const encryptWithPublicKey = (plaintext, recipientPublicKeyFile) => {
    const keyPath = resolveKeyFile(recipientPublicKeyFile);
    const { publicKey } = readJson(keyPath);

    if (!publicKey) {
        throw new Error("Recipient public key not found in key file");
    }

    const recipientPublicKey = asUint8(fromBase64(publicKey));
    const messageUint8 = naclUtil.decodeUTF8(plaintext);

    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);

    const boxed = nacl.box(
        messageUint8,
        nonce,
        recipientPublicKey,
        ephemeralKeyPair.secretKey
    );

    if (!boxed) {
        throw new Error("Encryption failed");
    }

    const payload = Buffer.concat([
        Buffer.from(ephemeralKeyPair.publicKey),
        Buffer.from(boxed),
    ]);

    return {
        ciphertextBase64: toBase64(payload),
        nonceBase64: toBase64(nonce),
    };
};

const decryptWithPrivateKey = (
    ciphertextBase64,
    nonceBase64,
    recipientPrivateKeyFile
) => {
    const keyPath = resolveKeyFile(recipientPrivateKeyFile);
    const { secretKey } = readJson(keyPath);

    if (!secretKey) {
        throw new Error("Recipient secret key not found in key file");
    }

    const payloadBuffer = fromBase64(ciphertextBase64);
    const nonceBuffer = fromBase64(nonceBase64);

    const ephemeralPublicKey = asUint8(
        payloadBuffer.subarray(0, nacl.box.publicKeyLength)
    );
    const ciphertext = asUint8(
        payloadBuffer.subarray(nacl.box.publicKeyLength)
    );
    const recipientSecretKey = asUint8(fromBase64(secretKey));

    const opened = nacl.box.open(
        ciphertext,
        asUint8(nonceBuffer),
        ephemeralPublicKey,
        recipientSecretKey
    );

    if (!opened) {
        throw new Error("Failed to decrypt message");
    }

    return naclUtil.encodeUTF8(opened);
};

const signMessage = (privateSignKeyFile, message) => {
    const keyPath = resolveKeyFile(privateSignKeyFile);
    const { secretKey } = readJson(keyPath);

    if (!secretKey) {
        throw new Error("Signing secret key not found in key file");
    }

    const secretKeyUint8 = asUint8(fromBase64(secretKey));
    const messageUint8 = naclUtil.decodeUTF8(message);
    const signature = nacl.sign.detached(messageUint8, secretKeyUint8);

    return toBase64(signature);
};

const verifySignature = (publicSignKeyFile, message, signatureBase64) => {
    const keyPath = resolveKeyFile(publicSignKeyFile);
    const { publicKey } = readJson(keyPath);

    if (!publicKey) {
        throw new Error("Signing public key not found in key file");
    }

    const publicKeyUint8 = asUint8(fromBase64(publicKey));
    const messageUint8 = naclUtil.decodeUTF8(message);
    const signatureUint8 = asUint8(fromBase64(signatureBase64));

    return nacl.sign.detached.verify(
        messageUint8,
        signatureUint8,
        publicKeyUint8
    );
};

const computeCommitment = (ciphertextBase64, nonceBase64) => {
    const hash = createHash("sha256");
    hash.update(ciphertextBase64);
    hash.update(nonceBase64);
    return hash.digest("hex");
};

module.exports = {
    genKeypair,
    encryptWithPublicKey,
    decryptWithPrivateKey,
    signMessage,
    verifySignature,
    computeCommitment,
    constants: {
        KEY_ALGO_BOX,
        KEY_ALGO_SIGN,
        keysRoot,
        KEYS_DIR,
    },
};
