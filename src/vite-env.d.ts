/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute URL for the API when it is hosted separately. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
