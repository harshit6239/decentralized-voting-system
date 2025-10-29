const {
    genKeypair,
    encryptWithPublicKey,
    decryptWithPrivateKey,
    signMessage,
    verifySignature,
    computeCommitment,
    constants,
} = require("../common/crypto");

describe("crypto utility helpers", () => {
    const createdFiles = [];

    afterAll(() => {
        console.log(
            `Test generated key files: ${JSON.stringify(createdFiles)}`
        );
    });

    test("round-trip encryption and signature verification", () => {
        const keyLabel = `tmpdemo-${Date.now()}`;
        const keyPaths = genKeypair(keyLabel);

        createdFiles.push(keyPaths[constants.KEY_ALGO_BOX]);
        createdFiles.push(keyPaths[constants.KEY_ALGO_SIGN]);

        console.log(
            `Generated key paths for ${keyLabel}: ${JSON.stringify(keyPaths)}`
        );

        const message = JSON.stringify({
            voterId: "12345",
            ballot: ["A", "B"],
        });

        const { ciphertextBase64, nonceBase64 } = encryptWithPublicKey(
            message,
            keyPaths[constants.KEY_ALGO_BOX]
        );

        const decrypted = decryptWithPrivateKey(
            ciphertextBase64,
            nonceBase64,
            keyPaths[constants.KEY_ALGO_BOX]
        );

        expect(decrypted).toBe(message);

        const commitment = computeCommitment(ciphertextBase64, nonceBase64);
        expect(commitment).toHaveLength(64);

        const signatureB64 = signMessage(
            keyPaths[constants.KEY_ALGO_SIGN],
            message
        );
        expect(typeof signatureB64).toBe("string");
        expect(signatureB64.length).toBeGreaterThan(0);

        const verified = verifySignature(
            keyPaths[constants.KEY_ALGO_SIGN],
            message,
            signatureB64
        );
        expect(verified).toBe(true);
    });
});
