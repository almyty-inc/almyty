export interface GreeterOptions {
  /** What every greeting starts with. */
  prefix: string;
}

/** Greets people. */
export declare class Greeter {
  constructor(options: GreeterOptions);
  /** Say hello to someone. */
  greet(name: string): Promise<string>;
  readonly math: {
    add(a: number, b: number): number;
  };
}

/** Upper-case a text. */
export declare function shout(text: string): string;
