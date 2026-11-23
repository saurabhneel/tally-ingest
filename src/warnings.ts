/**
 * A non-fatal diagnostic. Persisted on the import (and, where specific to one
 * voucher, on the voucher).
 *
 * Messages and details must be written by us. Never copy text from the uploaded
 * document into them, because they are stored, returned by the API and logged.
 */
export interface ImportWarning {
  code: string;
  message: string;
  /** Source location such as "VOUCHER/PERSISTEDVIEW" (element names only). */
  path?: string;
  details?: Record<string, string | number | boolean | string[] | number[]>;
}
