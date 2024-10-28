import { convert, getRandomBytes, toPKCS1, toPKCS8 } from './crypto';
import {
  ClientIdentification,
  DrmCertificate,
  EncryptedClientIdentification,
  FileHashes,
  SignedDrmCertificate,
} from './proto';
import { buildWvd, parseWvd, WVD_DEVICE_TYPES } from './wvd';
import { importCertificateKey } from './certificate';
import { Session, SessionType } from './session';

export const CLIENT_TYPE = { android: 'android', chrome: 'chrome' } as const;

export type ClientType = (typeof CLIENT_TYPE)[keyof typeof CLIENT_TYPE];
export type SecurityLevel = 1 | 2 | 3;

const types = new Map<number, ClientType>([
  [WVD_DEVICE_TYPES.android, CLIENT_TYPE.android],
  [WVD_DEVICE_TYPES.chrome, CLIENT_TYPE.chrome],
]);

export class Client {
  id: ClientIdentification;
  type: ClientType;
  securityLevel: SecurityLevel;
  signedDrmCertificate: SignedDrmCertificate;
  drmCertificate: DrmCertificate;
  systemId: number;
  vmp: FileHashes | null;
  info: Map<string, string>;

  #key?: { forDecrypt: CryptoKey; forSign: CryptoKey };

  static async importPacked(data: Uint8Array, format: 'WVDv2' = 'WVDv2') {
    if (format !== 'WVDv2') throw new Error('Only WVDv2 is supported');
    const parsed = parseWvd(data);
    const pcks1 = `-----BEGIN RSA PRIVATE KEY-----\n${convert.bytes(parsed.privateKey).toBase64()}\n-----END RSA PRIVATE KEY-----`;
    const key = convert.text(pcks1).toBuffer();
    const type = types.get(parsed.deviceType);
    const securityLevel = parsed.securityLevel as SecurityLevel;
    const client = new Client(parsed.clientId, type, securityLevel);
    await client.importKey(key);
    return client;
  }

  static async importUnpacked(
    id: Uint8Array,
    key: Uint8Array,
    vmp?: Uint8Array,
  ) {
    const client = new Client(id);
    if (vmp) {
      client.vmp = FileHashes.decode(vmp);
      client.id.vmpData = vmp;
    }
    await client.importKey(key);
    return client;
  }

  get key() {
    if (!this.#key) throw new Error('Import key before using it');
    return this.#key;
  }

  constructor(
    id: Uint8Array,
    type: ClientType = CLIENT_TYPE.android,
    securityLevel: SecurityLevel = 3,
  ) {
    this.id = ClientIdentification.decode(id);
    this.signedDrmCertificate = SignedDrmCertificate.decode(this.id.token);
    this.drmCertificate = DrmCertificate.decode(
      this.signedDrmCertificate.drmCertificate,
    );
    this.systemId = this.drmCertificate.systemId;
    this.vmp = this.id.vmpData ? FileHashes.decode(this.id.vmpData) : null;
    this.type = type;
    this.securityLevel = securityLevel;
    const clientInfo = this.id.clientInfo;
    this.info = new Map(clientInfo.map((item) => [item.name!, item.value!]));
  }

  async unpack(): Promise<[id: Uint8Array, key: Uint8Array]> {
    const id = ClientIdentification.encode(this.id).finish();
    const key = await this.exportKey();
    return [id, key];
  }

  async pack(format: 'WVDv2' = 'WVDv2') {
    if (format !== 'WVDv2') throw new Error('Only WVDv2 is supported');
    const id = ClientIdentification.encode(this.id).finish();
    const key = await this.exportKey();
    const keyDer = convert
      .bytes(key)
      .toText()
      .split('\n')
      .map((s) => s.trim())
      .slice(1, -1)
      .join('\n');
    const keyDerBinary = convert.base64(keyDer).toBuffer();
    const [type] = types.entries().find(([, type]) => type === this.type)!;
    const wvd = buildWvd({
      clientId: id,
      deviceType: type,
      securityLevel: this.securityLevel,
      privateKey: keyDerBinary,
    });
    return wvd;
  }

  async importKey(pkcs1: Uint8Array) {
    const pkcs1pem = convert.bytes(pkcs1).toText();
    const pkcs8pem = toPKCS8(pkcs1pem);
    const pemContents = pkcs8pem.split('\n').slice(1, -2).join('\n');
    const data = convert.base64(pemContents).toBuffer();
    const keyForDecrypt = await crypto.subtle.importKey(
      'pkcs8',
      data,
      { name: 'RSA-OAEP', hash: 'SHA-1' },
      true,
      ['decrypt'],
    );
    const keyForSign = await crypto.subtle.importKey(
      'pkcs8',
      data,
      { name: 'RSA-PSS', hash: 'SHA-1' },
      true,
      ['sign'],
    );
    this.#key = { forDecrypt: keyForDecrypt, forSign: keyForSign };
    return this.#key;
  }

  async exportKey() {
    const key = this.key.forSign;
    const der = await crypto.subtle.exportKey('pkcs8', key);
    const derAsBinary = new Uint8Array(der);
    const derAsBase64 = convert.bytes(derAsBinary).toBase64();
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pem = `${pemHeader}\n${derAsBase64}\n-----${pemFooter}-----`;
    const pkcs1 = toPKCS1(pem).trim();
    return convert.text(pkcs1).toBuffer();
  }

  async decryptWithKey(data: Uint8Array) {
    const result = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      this.key.forDecrypt,
      data,
    );
    return new Uint8Array(result);
  }

  async signWithKey(data: Uint8Array) {
    const result = await crypto.subtle.sign(
      { name: 'RSA-PSS', saltLength: 20 },
      this.key.forSign,
      data,
    );
    return new Uint8Array(result);
  }

  async encryptId(certificate: SignedDrmCertificate) {
    if (!certificate.drmCertificate)
      throw Error('Service certificate not found');
    const serviceCertificate = DrmCertificate.decode(
      certificate.drmCertificate,
    );
    const id = ClientIdentification.encode(this.id).finish();

    const privacyIv = getRandomBytes(16);
    const privacyKey = await crypto.subtle.generateKey(
      { name: 'AES-CBC', length: 128 },
      true,
      ['encrypt'],
    );

    const encryptedId = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: privacyIv },
      privacyKey,
      id,
    );
    const encryptedIdBuffer = new Uint8Array(encryptedId);

    const privacyKeyRaw = await crypto.subtle.exportKey('raw', privacyKey);
    const privacyKeyRawBuffer = new Uint8Array(privacyKeyRaw);
    const publicKey = await importCertificateKey(
      serviceCertificate.publicKey,
      'encrypt',
    );
    const encryptedKey = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      privacyKeyRawBuffer,
    );
    const encryptedKeyBuffer = new Uint8Array(encryptedKey);

    const properties = {
      providerId: serviceCertificate.providerId,
      serviceCertificateSerialNumber: serviceCertificate.serialNumber,
      encryptedClientIdIv: privacyIv,
      encryptedPrivacyKey: encryptedKeyBuffer,
      encryptedClientId: encryptedIdBuffer,
    };

    return EncryptedClientIdentification.create(properties);
  }

  toString() {
    return `${this.systemId} L${this.securityLevel}`;
  }

  /**
   * https://www.w3.org/TR/encrypted-media-2/#navigator-extension-requestmediakeysystemaccess
   */
  requestMediaKeySystemAccess(
    keySystem: string,
    supportedConfigurations: MediaKeySystemConfiguration[],
  ) {
    if (keySystem !== 'com.widevine.alpha')
      throw new Error('Unsupported media key system');
    return {
      keySystem,
      createMediaKeys: async () => {
        const state = { serverCertificate: null as BufferSource | null };
        return {
          createSession: (sessionType?: SessionType): MediaKeySession => {
            return new Session(sessionType, this);
          },
          setServerCertificate: async (
            serverCertificate: BufferSource,
          ): Promise<boolean> => {
            state.serverCertificate = serverCertificate;
            return true;
          },
          getStatusForPolicy: async (): Promise<MediaKeyStatus> => 'usable',
        };
      },
      getConfiguration: () => supportedConfigurations[0],
    };
  }
}
