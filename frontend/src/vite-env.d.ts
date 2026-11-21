/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin for the Android app build, e.g. https://api.example.com (no trailing slash). */
  readonly VITE_API_URL?: string;
  /** "true" marks every SOS text as a TEST so real contacts are not alarmed. */
  readonly VITE_TEST_MODE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
