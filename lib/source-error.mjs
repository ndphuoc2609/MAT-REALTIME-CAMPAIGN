export class SourceError extends Error {
  constructor(message, status = 'error') {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}
