/**
 * ============================================================================
 * crypto.js — AES-GCM 加解密封装
 * ============================================================================
 *
 * 【本次重构关键改动】
 *   · decryptString 增加长度校验：密文长度必须 >= 12 (IV) + 16 (GCM tag)，
 *     否则抛出明确的错误，避免后续 slice 得到空数据导致诡异错误。
 * ============================================================================
 */

const AES_KEY_LENGTH_BITS = 256;
const AES_IV_LENGTH_BYTES = 12;
const AES_GCM_TAG_LENGTH_BYTES = 16;
const AES_ALGORITHM_NAME = 'AES-GCM';

export async function generateAesKey() {
    return await window.crypto.subtle.generateKey(
        {
            name: AES_ALGORITHM_NAME,
            length: AES_KEY_LENGTH_BITS
        },
        true,
        ['encrypt', 'decrypt']
    );
}

export async function importAesKeyFromRawBytes(rawKeyBytes) {
    return await window.crypto.subtle.importKey(
        'raw',
        rawKeyBytes,
        { name: AES_ALGORITHM_NAME },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function exportAesKeyToRawBytes(cryptoKey) {
    const exportedArrayBuffer = await window.crypto.subtle.exportKey('raw', cryptoKey);
    return new Uint8Array(exportedArrayBuffer);
}

export async function encryptString(plainText, cryptoKey) {
    const initializationVector = window.crypto.getRandomValues(
        new Uint8Array(AES_IV_LENGTH_BYTES)
    );

    const encodedPlainBytes = new TextEncoder().encode(plainText);

    const encryptedArrayBuffer = await window.crypto.subtle.encrypt(
        {
            name: AES_ALGORITHM_NAME,
            iv: initializationVector
        },
        cryptoKey,
        encodedPlainBytes
    );

    const encryptedBytes = new Uint8Array(encryptedArrayBuffer);
    const combinedBytes = new Uint8Array(
        initializationVector.length + encryptedBytes.byteLength
    );
    combinedBytes.set(initializationVector, 0);
    combinedBytes.set(encryptedBytes, initializationVector.length);

    return combinedBytes;
}

export async function decryptString(cipherBytes, cryptoKey) {
    if (!cipherBytes || cipherBytes.length < AES_IV_LENGTH_BYTES + AES_GCM_TAG_LENGTH_BYTES) {
        throw new Error('密文长度不足，可能已损坏');
    }

    const initializationVector = cipherBytes.slice(0, AES_IV_LENGTH_BYTES);
    const encryptedPayload = cipherBytes.slice(AES_IV_LENGTH_BYTES);

    const decryptedArrayBuffer = await window.crypto.subtle.decrypt(
        {
            name: AES_ALGORITHM_NAME,
            iv: initializationVector
        },
        cryptoKey,
        encryptedPayload
    );

    return new TextDecoder().decode(decryptedArrayBuffer);
}