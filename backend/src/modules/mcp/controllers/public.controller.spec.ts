import { Test, TestingModule } from '@nestjs/testing';
import { PublicController } from './public.controller';

describe('PublicController', () => {
  let controller: PublicController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicController],
    }).compile();

    controller = module.get<PublicController>(PublicController);
  });

  describe('a2aDiscovery', () => {
    it('should return A2A discovery information', async () => {
      const result = await controller.a2aDiscovery();

      expect(result.protocol).toBe('a2a');
      expect(result.version).toBeDefined();
      expect(result.server).toBeDefined();
      expect(result.endpoints).toBeDefined();
      expect(result.capabilities).toBeDefined();
      expect(result.experimental).toBeDefined();
    });
  });

  describe('a2aCapabilities', () => {
    it('should return A2A capabilities', async () => {
      const result = await controller.a2aCapabilities();

      expect(result.protocol).toBe('a2a');
      expect(result.version).toBeDefined();
      expect(Array.isArray(result.supportedMessageTypes)).toBe(true);
      expect(Array.isArray(result.supportedAgentTypes)).toBe(true);
      expect(Array.isArray(result.features)).toBe(true);
    });
  });

  describe('a2aHealth', () => {
    it('should return A2A health status', async () => {
      const result = await controller.a2aHealth();

      expect(result.protocol).toBe('a2a');
      expect(result.status).toBeDefined();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.features).toBeDefined();
      expect(result.server).toBe('almyty');
      expect(result.version).toBeDefined();
    });
  });
});