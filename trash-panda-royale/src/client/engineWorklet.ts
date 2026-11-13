/**
 * The AudioWorklet that runs an EngineSynth: one per engine voice. Its revs and fuel are
 * parameters (k-rate: the voice smooths them); "pop" fires an afterfire, { stop: s } ends it.
 * Loaded by Sfx (`?worker&url`, so Vite bundles it with engineSynth.ts).
 */
import { EngineSynth, type SynthSpec } from "./engineSynth.js";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rpm", defaultValue: 0, minValue: 0, maxValue: 12000, automationRate: "k-rate" },
      { name: "fuel", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  private synth: EngineSynth;
  /** Samples left to render once told to stop (−1: running). */
  private left = -1;

  constructor(options: { processorOptions: { spec: SynthSpec; seed: number } }) {
    super(options);
    this.synth = new EngineSynth(options.processorOptions.spec, sampleRate, options.processorOptions.seed);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === "pop") this.synth.pop();
      else if (e.data?.stop !== undefined) this.left = Math.round(e.data.stop * sampleRate);
    };
  }

  // two channels out: the exhaust's tone, and its noise (the voice filters them apart)
  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const tone = outputs[0]?.[0];
    if (tone) this.synth.render(tone, params.rpm[0], params.fuel[0], outputs[0][1]);
    if (this.left >= 0) {
      this.left -= tone?.length ?? 128;
      if (this.left <= 0) return false;
    }
    return true;
  }
}

registerProcessor("engine", EngineProcessor);
