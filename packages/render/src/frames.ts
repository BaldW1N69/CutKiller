import type { Readable } from "node:stream";

/** Reads fixed-size raw frames from a stream; returns null once the stream ends. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private waiter: (() => void) | null = null;

  constructor(
    stream: Readable,
    private readonly frameSize: number,
  ) {
    stream.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      // Bounded buffering: pause the decoder once a few frames are waiting.
      if (this.buffered > frameSize * 4) stream.pause();
      this.wake();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("error", () => {
      this.ended = true;
      this.wake();
    });
    this.stream = stream;
  }

  private readonly stream: Readable;

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async next(): Promise<Buffer | null> {
    while (this.buffered < this.frameSize) {
      if (this.ended) return null;
      this.stream.resume();
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
    const frame = Buffer.allocUnsafe(this.frameSize);
    let offset = 0;
    while (offset < this.frameSize) {
      const head = this.chunks[0] as Buffer;
      const take = Math.min(head.length, this.frameSize - offset);
      head.copy(frame, offset, 0, take);
      offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= this.frameSize;
    if (this.buffered <= this.frameSize * 2) this.stream.resume();
    return frame;
  }
}
