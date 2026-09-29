import { BadRequestException } from '@nestjs/common';

import {
  describeLabelRequirements,
  labelsMatch,
  noMatchingRunnerMessage,
  parseLabelRequirements,
} from './runner-labels';

describe('runner label requirements', () => {
  describe('parseLabelRequirements', () => {
    it('reads what a person types: key=value pairs split by commas or lines', () => {
      expect(parseLabelRequirements('os=mac, gpu=yes')).toEqual({ os: 'mac', gpu: 'yes' });
      expect(parseLabelRequirements('os=mac\ngpu=yes\n')).toEqual({ os: 'mac', gpu: 'yes' });
    });

    it('takes an object as sent by the API', () => {
      expect(parseLabelRequirements({ gpu: 'yes', cores: 8 })).toEqual({ gpu: 'yes', cores: '8' });
    });

    it('treats empty as no requirement', () => {
      expect(parseLabelRequirements(undefined)).toEqual({});
      expect(parseLabelRequirements('')).toEqual({});
      expect(parseLabelRequirements(' , ')).toEqual({});
      expect(parseLabelRequirements({})).toEqual({});
    });

    it('refuses something that is not key=value, saying how to write it', () => {
      for (const bad of ['gpu', '=yes', 'gpu=', 'gpu = ']) {
        const err = (() => { try { parseLabelRequirements(bad); } catch (e) { return e; } })() as any;
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.message).toMatch(/key=value|both sides/);
      }
      expect(() => parseLabelRequirements(['gpu=yes'])).toThrow(BadRequestException);
      expect(() => parseLabelRequirements({ gpu: { nested: true } })).toThrow(BadRequestException);
    });

    it('caps how many and how long', () => {
      const many = Array.from({ length: 21 }, (_, i) => `k${i}=v`).join(',');
      expect(() => parseLabelRequirements(many)).toThrow(BadRequestException);
      expect(() => parseLabelRequirements(`k=${'v'.repeat(65)}`)).toThrow(BadRequestException);
    });
  });

  describe('labelsMatch', () => {
    it('needs every requirement, allows extra labels', () => {
      expect(labelsMatch({ os: 'mac', gpu: 'yes', env: 'dev' }, { os: 'mac', gpu: 'yes' })).toBe(true);
      expect(labelsMatch({ os: 'mac' }, { os: 'mac', gpu: 'yes' })).toBe(false);
      expect(labelsMatch({ os: 'linux', gpu: 'yes' }, { os: 'mac', gpu: 'yes' })).toBe(false);
    });

    it('ignores case and surrounding space', () => {
      expect(labelsMatch({ OS: ' Mac ' }, { os: 'mac' })).toBe(true);
    });

    it('matches anything when nothing is required, and nothing when a runner has no labels', () => {
      expect(labelsMatch({}, {})).toBe(true);
      expect(labelsMatch(null, undefined)).toBe(true);
      expect(labelsMatch(null, { gpu: 'yes' })).toBe(false);
    });
  });

  it('describes requirements and the no-match case in plain words', () => {
    expect(describeLabelRequirements({ os: 'mac', gpu: 'yes' })).toBe('os=mac, gpu=yes');
    expect(noMatchingRunnerMessage({ gpu: 'yes' })).toBe('No machine with gpu=yes is online');
  });
});
