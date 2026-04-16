export class OperationController {
  private _abortController: AbortController = new AbortController();
  private _stopped = false;

  public reset(): void {
    this._stopped = false;
    this._abortController = new AbortController();
  }

  public stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    try {
      this._abortController.abort();
    } catch {
      // ignore
    }
  }

  public isStopped(): boolean {
    return this._stopped;
  }

  public signal(): AbortSignal {
    return this._abortController.signal;
  }
}

