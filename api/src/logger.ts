import pino, { multistream } from "pino";
import { createStream } from "pino-seq";

function buildDestination(): pino.DestinationStream {
  const streams: pino.StreamEntry[] = [{ stream: pino.destination(1) }];

  const seqUrl = process.env.SEQ_URL;
  if (seqUrl) {
    streams.push({
      stream: createStream({
        serverUrl: seqUrl,
        apiKey: process.env.SEQ_API_KEY,
      }),
    });
  }

  return multistream(streams);
}

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  buildDestination(),
);

export type Logger = pino.Logger;

export function createLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
