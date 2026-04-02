import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { VersionsService } from '../versions.service';
import { VersionsController } from '../versions.controller';
import { Version } from 'typeorm-versions';

describe('VersionsService', () => {
  let service: VersionsService;
  let mockVersionRepo: Partial<Repository<Version>>;
  let mockDataSource: Partial<DataSource>;

  beforeEach(async () => {
    mockVersionRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
    };

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockVersionRepo),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VersionsService,
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<VersionsService>(VersionsService);
  });

  describe('getVersions', () => {
    it('should query versions with correct entityType, entityId, and order', async () => {
      const mockVersions = [
        { id: 2, itemType: 'Agent', itemId: 'abc-123', event: 'UPDATE', object: { name: 'v2' }, timestamp: new Date('2026-04-02') },
        { id: 1, itemType: 'Agent', itemId: 'abc-123', event: 'INSERT', object: { name: 'v1' }, timestamp: new Date('2026-04-01') },
      ];
      (mockVersionRepo.find as jest.Mock).mockResolvedValue(mockVersions);

      const result = await service.getVersions('Agent', 'abc-123');

      expect(mockDataSource.getRepository).toHaveBeenCalledWith(Version);
      expect(mockVersionRepo.find).toHaveBeenCalledWith({
        where: { itemType: 'Agent', itemId: 'abc-123' },
        order: { timestamp: 'DESC' },
      });
      expect(result).toEqual(mockVersions);
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no versions exist', async () => {
      (mockVersionRepo.find as jest.Mock).mockResolvedValue([]);

      const result = await service.getVersions('Tool', 'nonexistent-id');

      expect(result).toEqual([]);
    });

    it('should isolate versions by entity type', async () => {
      (mockVersionRepo.find as jest.Mock).mockResolvedValue([]);

      await service.getVersions('Agent', 'shared-id');

      expect(mockVersionRepo.find).toHaveBeenCalledWith({
        where: { itemType: 'Agent', itemId: 'shared-id' },
        order: { timestamp: 'DESC' },
      });

      await service.getVersions('Tool', 'shared-id');

      expect(mockVersionRepo.find).toHaveBeenCalledWith({
        where: { itemType: 'Tool', itemId: 'shared-id' },
        order: { timestamp: 'DESC' },
      });
    });
  });

  describe('getVersion', () => {
    it('should return version by id', async () => {
      const mockVersion = {
        id: 5,
        itemType: 'Agent',
        itemId: 'abc-123',
        event: 'UPDATE',
        object: { name: 'Test Agent', pipeline: { nodes: [], edges: [] } },
        timestamp: new Date('2026-04-02'),
      };
      (mockVersionRepo.findOne as jest.Mock).mockResolvedValue(mockVersion);

      const result = await service.getVersion(5);

      expect(mockVersionRepo.findOne).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(result).toEqual(mockVersion);
      expect(result.object).toHaveProperty('name', 'Test Agent');
    });

    it('should return null for non-existent version', async () => {
      (mockVersionRepo.findOne as jest.Mock).mockResolvedValue(null);

      const result = await service.getVersion(999);

      expect(result).toBeNull();
    });
  });

  describe('rollback', () => {
    it('should return the object snapshot from the specified version', async () => {
      const snapshot = { name: 'Old Agent', status: 'active', pipeline: { nodes: [{ id: 'input_1' }], edges: [] } };
      const mockVersion = {
        id: 3,
        itemType: 'Agent',
        itemId: 'abc-123',
        event: 'UPDATE',
        object: snapshot,
        timestamp: new Date('2026-04-01'),
      };
      (mockVersionRepo.findOne as jest.Mock).mockResolvedValue(mockVersion);

      const result = await service.rollback('Agent', 'abc-123', 3);

      expect(result).toEqual(snapshot);
    });

    it('should throw error when version not found', async () => {
      (mockVersionRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.rollback('Agent', 'abc-123', 999)).rejects.toThrow('Version not found');
    });
  });

  describe('version history chain', () => {
    it('should return versions in correct order for multiple updates', async () => {
      const versions = [
        { id: 3, itemType: 'Gateway', itemId: 'gw-1', event: 'UPDATE', object: { name: 'v3' }, timestamp: new Date('2026-04-03') },
        { id: 2, itemType: 'Gateway', itemId: 'gw-1', event: 'UPDATE', object: { name: 'v2' }, timestamp: new Date('2026-04-02') },
        { id: 1, itemType: 'Gateway', itemId: 'gw-1', event: 'INSERT', object: { name: 'v1' }, timestamp: new Date('2026-04-01') },
      ];
      (mockVersionRepo.find as jest.Mock).mockResolvedValue(versions);

      const result = await service.getVersions('Gateway', 'gw-1');

      expect(result).toHaveLength(3);
      expect(result[0].event).toBe('UPDATE');
      expect(result[0].object).toEqual({ name: 'v3' });
      expect(result[2].event).toBe('INSERT');
      expect(result[2].object).toEqual({ name: 'v1' });
    });
  });

  describe('entity type isolation', () => {
    it('should not mix versions from different entity types', async () => {
      // First call returns Agent versions
      (mockVersionRepo.find as jest.Mock).mockResolvedValueOnce([
        { id: 1, itemType: 'Agent', itemId: 'id-1', event: 'INSERT', object: { name: 'Agent 1' } },
      ]);
      // Second call returns Tool versions
      (mockVersionRepo.find as jest.Mock).mockResolvedValueOnce([
        { id: 2, itemType: 'Tool', itemId: 'id-1', event: 'INSERT', object: { name: 'Tool 1' } },
      ]);

      const agentVersions = await service.getVersions('Agent', 'id-1');
      const toolVersions = await service.getVersions('Tool', 'id-1');

      expect(agentVersions).toHaveLength(1);
      expect(agentVersions[0].itemType).toBe('Agent');
      expect(toolVersions).toHaveLength(1);
      expect(toolVersions[0].itemType).toBe('Tool');

      // Verify the correct where clauses were used
      expect(mockVersionRepo.find).toHaveBeenNthCalledWith(1, {
        where: { itemType: 'Agent', itemId: 'id-1' },
        order: { timestamp: 'DESC' },
      });
      expect(mockVersionRepo.find).toHaveBeenNthCalledWith(2, {
        where: { itemType: 'Tool', itemId: 'id-1' },
        order: { timestamp: 'DESC' },
      });
    });
  });
});

describe('VersionsController', () => {
  let controller: VersionsController;
  let mockService: Partial<VersionsService>;

  beforeEach(async () => {
    mockService = {
      getVersions: jest.fn(),
      getVersion: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VersionsController],
      providers: [
        { provide: VersionsService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<VersionsController>(VersionsController);
  });

  describe('getVersions', () => {
    it('should return versions wrapped in success response', async () => {
      const mockVersions = [
        { id: 1, itemType: 'Agent', itemId: 'abc', event: 'INSERT', object: {} },
      ];
      (mockService.getVersions as jest.Mock).mockResolvedValue(mockVersions);

      const result = await controller.getVersions('Agent', 'abc');

      expect(result).toEqual({ success: true, data: mockVersions });
      expect(mockService.getVersions).toHaveBeenCalledWith('Agent', 'abc');
    });

    it('should throw HttpException on service error', async () => {
      (mockService.getVersions as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(controller.getVersions('Agent', 'abc')).rejects.toThrow();
    });
  });

  describe('getVersion', () => {
    it('should return version detail', async () => {
      const mockVersion = { id: 5, itemType: 'Tool', itemId: 'xyz', event: 'UPDATE', object: { name: 'v2' } };
      (mockService.getVersion as jest.Mock).mockResolvedValue(mockVersion);

      const result = await controller.getVersion('5');

      expect(result).toEqual({ success: true, data: mockVersion });
      expect(mockService.getVersion).toHaveBeenCalledWith(5);
    });

    it('should return 404 for non-existent version', async () => {
      (mockService.getVersion as jest.Mock).mockResolvedValue(null);

      await expect(controller.getVersion('999')).rejects.toThrow();
    });
  });
});
