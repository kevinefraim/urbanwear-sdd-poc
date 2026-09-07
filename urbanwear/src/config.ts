export type RuntimeConfig = {
  port: number;
  databasePath: string;
  testNow?: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "urbanwear.db",
    testNow: env.TEST_NOW || undefined,
  };
}
