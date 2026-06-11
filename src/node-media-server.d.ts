declare module "node-media-server" {
  export type NodeMediaSession = {
    id: string;
    ip: string;
    protocol: string;
    streamApp: string;
    streamName: string;
    streamPath: string;
    close: () => void;
  };

  export type NodeMediaServerConfig = {
    bind?: string;
    rtmp?: {
      port: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
  };

  export default class NodeMediaServer {
    constructor(config: NodeMediaServerConfig);
    on(
      eventName: "prePublish" | "postPublish" | "donePublish",
      listener: (session: NodeMediaSession) => void,
    ): void;
    run(): void;
  }
}
