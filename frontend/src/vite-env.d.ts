/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin for the Android app build, e.g. https://api.example.com (no trailing slash). */
  readonly VITE_API_URL?: string;
  /** Hosted backend included alongside the local API in the admin dashboard. */
  readonly VITE_HOSTED_API_URL?: string;
  /** "true" marks every SOS text as a TEST so real contacts are not alarmed. */
  readonly VITE_TEST_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
