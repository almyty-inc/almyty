import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { AuthService, JwtPayload, AuthTokens } from './auth.service';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

// Unmock bcrypt from global setup to test actual hashing
jest.unmock('bcryptjs');

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: jest.Mocked<Repository<User>>;
  let apiKeyRepository: jest.Mocked<Repository<ApiKey>>;
  let organizationRepository: jest.Mocked<Repository<Organization>>;
  let userOrganizationRepository: jest.Mocked<Repository<UserOrganization>>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
    // register() now wraps user + org + membership in a DB transaction,
    // so we need a `manager.transaction` that runs the callback with a
    // transactional manager whose .create/.save delegate straight to the
    // repository mocks. That keeps every existing repository assertion
    // (e.g. expect(userRepository.save).toHaveBeenCalled()) working
    // without rewriting every call site.
    const transactionalManager = {
      create: (entityClass: any, data: any) => {
        if (entityClass === User) return mockUserRepository.create(data);
        if (entityClass === Organization) return mockOrganizationRepository.create(data);
        if (entityClass === UserOrganization) return mockUserOrganizationRepository.create(data);
        return data;
      },
      save: (entityClass: any, entity: any) => {
        if (entityClass === User) return mockUserRepository.save(entity);
        if (entityClass === Organization) return mockOrganizationRepository.save(entity);
        if (entityClass === UserOrganization) return mockUserOrganizationRepository.save(entity);
        return entity;
      },
    };
    const mockManager = {
      transaction: jest.fn(async (cb: any) => cb(transactionalManager)),
    };

    const mockUserRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      manager: mockManager,
    };

    const mockApiKeyRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
    };

    const mockOrganizationRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    const mockUserOrganizationRepository = {
      create: jest.fn(),
      save: jest.fn(),
    };

    const mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: mockApiKeyRepository,
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: mockOrganizationRepository,
        },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: mockUserOrganizationRepository,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(null),
            logCreate: jest.fn().mockResolvedValue(null),
            logUpdate: jest.fn().mockResolvedValue(null),
            logDelete: jest.fn().mockResolvedValue(null),
            logToolExecution: jest.fn().mockResolvedValue(null),
            logGatewayRequest: jest.fn().mockResolvedValue(null),
            logRunEvent: jest.fn().mockResolvedValue(null),
            computeChanges: jest.fn().mockReturnValue([]),
            findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
            getResourceHistory: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get(getRepositoryToken(User));
    apiKeyRepository = module.get(getRepositoryToken(ApiKey));
    organizationRepository = module.get(getRepositoryToken(Organization));
    userOrganizationRepository = module.get(getRepositoryToken(UserOrganization));
    jwtService = module.get(JwtService);

    // Reset repository mocks but not bcrypt mocks
    userRepository.findOne.mockReset();
    userRepository.create.mockReset();
    userRepository.save.mockReset();
    apiKeyRepository.findOne.mockReset();
    organizationRepository.findOne.mockReset();
    organizationRepository.create.mockReset();
    organizationRepository.save.mockReset();
    userOrganizationRepository.create.mockReset();
    userOrganizationRepository.save.mockReset();
    jwtService.sign.mockReset();
  });

  describe('register', () => {
    const createUserDto: CreateUserDto = {
      email: 'test@example.com',
      password: 'SecurePassword123!',
      firstName: 'John',
      lastName: 'Doe',
      organizationName: 'Test Organization',
    };

    it('should register a new user successfully', async () => {
      // Mock user doesn't exist
      userRepository.findOne.mockResolvedValue(null);

      // Mock organization name available
      organizationRepository.findOne.mockResolvedValue(null);

      let savedUser: User;
      userRepository.create.mockImplementation((userData) => userData as User);
      userRepository.save.mockImplementation((user) => {
        savedUser = { ...user, id: 'user-123' } as User;
        return Promise.resolve(savedUser);
      });

      // Mock organization creation
      const mockOrganization = {
        id: 'org-123',
        name: createUserDto.organizationName,
        plan: 'free',
        isActive: true,
      } as Organization;

      organizationRepository.create.mockReturnValue(mockOrganization);
      organizationRepository.save.mockResolvedValue(mockOrganization);

      // Mock user organization creation
      const mockUserOrganization = {
        userId: 'user-123',
        organizationId: mockOrganization.id,
        role: OrganizationRole.OWNER,
      } as UserOrganization;

      userOrganizationRepository.create.mockReturnValue(mockUserOrganization);
      userOrganizationRepository.save.mockResolvedValue(mockUserOrganization);

      // Mock JWT token generation
      jwtService.sign.mockReturnValue('mock-token');

      // Mock the second findOne call in generateTokens (with relationships)
      const userWithOrgs = {
        id: 'user-123',
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        organizationMemberships: [{
          id: 'membership-1',
          userId: 'user-123',
          organizationId: mockOrganization.id,
          role: OrganizationRole.OWNER,
          isActive: true,
          inviteAccepted: true,
          joinedAt: new Date(),
          organization: mockOrganization,
        } as any],
        fullName: `${createUserDto.firstName} ${createUserDto.lastName}`,
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;
      userRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(userWithOrgs);

      const result = await service.register(createUserDto);

      expect(result).toEqual({
        accessToken: 'mock-token',
        refreshToken: 'mock-token',
        expiresIn: 86400,
      });

      // Verify password was actually hashed with bcrypt
      expect(savedUser.passwordHash).toBeDefined();
      expect(savedUser.passwordHash).not.toBe(createUserDto.password);

      // Verify the hash is actually valid
      const isPasswordValid = await bcrypt.compare(createUserDto.password, savedUser.passwordHash);
      expect(isPasswordValid).toBe(true);

      expect(userRepository.create).toHaveBeenCalled();
      expect(userRepository.save).toHaveBeenCalled();
      expect(organizationRepository.create).toHaveBeenCalled();
      expect(organizationRepository.save).toHaveBeenCalled();
      expect(userOrganizationRepository.create).toHaveBeenCalled();
      expect(userOrganizationRepository.save).toHaveBeenCalled();
    });

    it('auto-provisions the default "Everyone" team and joins the owner as LEAD on register', async () => {
      // Capture the team + user-team rows that the register transaction
      // tries to save. The existing transactionalManager passes Team /
      // UserTeam saves through unchanged (returns `data`); we layer a
      // spy on top to assert against them. Regression for the original
      // teams-empty-for-fresh-org bug: register() used to create the
      // user + organization + user-organization rows but never
      // provisioned the default team, so a freshly-signed-up org owner
      // saw an empty Teams tab and was blocked from any team-scoped
      // visibility option in the create-API / create-tool dialogs.
      const teamSaves: any[] = [];
      const userTeamSaves: any[] = [];
      const savedOrg: any = { id: 'org-123', name: createUserDto.organizationName, plan: 'free', isActive: true };
      const userRepo: any = (service as any).userRepository;
      const orgRepo: any = (service as any).organizationRepository;
      // Replace the manager.transaction so we can pass our own
      // entity-aware save spies and stamp savedTeam.id.
      userRepo.manager.transaction = jest.fn(async (cb: any) => cb({
        create: (entityClass: any, data: any) => data,
        save: jest.fn(async (entityClass: any, entity: any) => {
          const name = entityClass?.name ?? '';
          if (name === 'User') return { ...entity, id: 'user-123' };
          if (name === 'Organization') return savedOrg;
          if (name === 'UserOrganization') return entity;
          if (name === 'Team') {
            const saved = { ...entity, id: 'team-default' };
            teamSaves.push(saved);
            return saved;
          }
          if (name === 'UserTeam') {
            userTeamSaves.push(entity);
            return entity;
          }
          return entity;
        }),
      }));

      userRepo.findOne.mockResolvedValueOnce(null); // user not found
      orgRepo.findOne.mockResolvedValue(null); // org name available
      jwtService.sign.mockReturnValue('mock-token');
      // The token generation reads the user back with memberships.
      userRepo.findOne.mockResolvedValueOnce({
        id: 'user-123',
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        organizationMemberships: [],
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any);

      await service.register(createUserDto);

      expect(teamSaves).toHaveLength(1);
      expect(teamSaves[0]).toMatchObject({
        organizationId: savedOrg.id,
        name: 'Everyone',
        isDefault: true,
      });
      expect(userTeamSaves).toHaveLength(1);
      expect(userTeamSaves[0]).toMatchObject({
        userId: 'user-123',
        teamId: 'team-default',
        role: 'lead',
        isActive: true,
      });
    });


    it('should throw error if user already exists', async () => {
      const existingUser = { id: 'existing-user' } as User;
      userRepository.findOne.mockResolvedValue(existingUser);

      await expect(service.register(createUserDto))
        .rejects
        .toThrow(new BadRequestException('User with this email already exists'));
    });

    it('should throw error if organization name is taken', async () => {
      // Mock user doesn't exist
      userRepository.findOne.mockResolvedValue(null);

      // Password hashing is mocked globally

      // Mock user creation and save
      const mockUser = { id: 'user-123' } as User;
      userRepository.create.mockReturnValue(mockUser);
      userRepository.save.mockResolvedValue(mockUser);

      // Mock organization name availability check
      userRepository.findOne.mockResolvedValue(null); // User doesn't exist
      jest.spyOn(service, 'isOrganizationNameAvailable').mockResolvedValue(false);

      await expect(service.register(createUserDto))
        .rejects
        .toThrow(new BadRequestException('Organization name is already taken'));
    });
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      email: 'test@example.com',
      password: 'SecurePassword123!',
    };

    it('should login user successfully', async () => {
      // Create a real password hash
      const passwordHash = await bcrypt.hash(loginDto.password, 12);

      const mockUser = {
        id: 'user-123',
        email: loginDto.email,
        isActive: true,
        passwordHash,
        organizationMemberships: [],
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue(mockUser);
      jwtService.sign.mockReturnValue('mock-token');

      const result = await service.login(loginDto);

      expect(result).toEqual({
        accessToken: 'mock-token',
        refreshToken: 'mock-token',
        expiresIn: 86400,
      });

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: loginDto.email },
        relations: ['organizationMemberships', 'organizationMemberships.organization'],
      });
      expect(userRepository.save).toHaveBeenCalled(); // For updating lastLoginAt
    });

    it('should throw error for invalid credentials', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.login(loginDto))
        .rejects
        .toThrow(new UnauthorizedException('Invalid credentials'));
    });

    it('should throw error for wrong password', async () => {
      // Hash a different password than what will be provided
      const passwordHash = await bcrypt.hash('DifferentPassword123!', 12);

      const mockUser = {
        id: 'user-123',
        email: loginDto.email,
        isActive: true,
        passwordHash,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.login(loginDto))
        .rejects
        .toThrow(new UnauthorizedException('Invalid credentials'));
    });
  });

  describe('validateUser', () => {
    it('should validate user with correct credentials', async () => {
      const testPassword = 'CorrectPassword123!';
      const passwordHash = await bcrypt.hash(testPassword, 12);

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        isActive: true,
        passwordHash,
        organizationMemberships: [],
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateUser('test@example.com', testPassword);

      expect(result).toBe(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
        relations: ['organizationMemberships', 'organizationMemberships.organization'],
      });
    });

    it('should return null for non-existent user', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateUser('test@example.com', 'password');

      expect(result).toBeNull();
    });

    it('should return null for inactive user', async () => {
      const mockUser = {
        id: 'user-123',
        isActive: false,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateUser('test@example.com', 'password');

      expect(result).toBeNull();
    });

    it('should return null for wrong password', async () => {
      const passwordHash = await bcrypt.hash('CorrectPassword123!', 12);

      const mockUser = {
        id: 'user-123',
        isActive: true,
        passwordHash,
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateUser('test@example.com', 'wrong-password');

      expect(result).toBeNull();
    });
  });

  describe('validateJwtPayload', () => {
    it('should validate JWT payload successfully', async () => {
      const mockUser = {
        id: 'user-123',
        isActive: true,
        organizationMemberships: [],
      } as User;

      const payload: JwtPayload = {
        sub: 'user-123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        organizations: [],
      };

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateJwtPayload(payload);

      expect(result).toBe(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: payload.sub },
        relations: ['organizationMemberships', 'organizationMemberships.organization'],
      });
    });

    it('should return null for non-existent user', async () => {
      const payload: JwtPayload = {
        sub: 'non-existent',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        organizations: [],
      };

      userRepository.findOne.mockResolvedValue(null);

      const result = await service.validateJwtPayload(payload);

      expect(result).toBeNull();
    });

    it('should return null for inactive user', async () => {
      const mockUser = {
        id: 'user-123',
        isActive: false,
      } as User;

      const payload: JwtPayload = {
        sub: 'user-123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        organizations: [],
      };

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateJwtPayload(payload);

      expect(result).toBeNull();
    });
  });

  describe('validateApiKey', () => {
    it('should validate API key successfully', async () => {
      const mockApiKey = {
        id: 'api-key-123',
        keyHash: 'hashed-key',
        isActive: true,
        user: { id: 'user-123', isActive: true },
        canMakeRequest: jest.fn().mockReturnValue(true),
        updateLastUsed: jest.fn(),
      } as any;

      apiKeyRepository.findOne.mockResolvedValue(mockApiKey);

      const result = await service.validateApiKey('hashed-key');

      expect(result).toBe(mockApiKey);
      expect(apiKeyRepository.findOne).toHaveBeenCalledWith({
        where: { keyHash: 'hashed-key' },
        relations: ['user', 'user.organizationMemberships', 'user.organizationMemberships.organization', 'organization'],
      });
    });

    it('should return null for invalid API key', async () => {
      apiKeyRepository.findOne.mockResolvedValue(null);

      const result = await service.validateApiKey('invalid-key');

      expect(result).toBeNull();
    });
  });

  describe('generateTokens', () => {
    it('should generate access and refresh tokens', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        organizationMemberships: [
          {
            organizationId: 'org-123',
            role: OrganizationRole.OWNER,
            organization: { id: 'org-123', name: 'Test Org' },
          },
        ],
      } as User;

      jwtService.sign.mockReturnValueOnce('access-token').mockReturnValueOnce('refresh-token');

      // Mock userRepository.findOne call inside generateTokens
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.generateTokens(mockUser);

      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 86400,
      });

      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });
  });

  describe('isOrganizationNameAvailable', () => {
    it('should return true if organization name is available', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      const result = await service.isOrganizationNameAvailable('Available Name');

      expect(result).toBe(true);
      expect(organizationRepository.findOne).toHaveBeenCalledWith({
        where: { name: 'Available Name' },
      });
    });

    it('should return false if organization name is taken', async () => {
      const existingOrg = { id: 'existing' } as Organization;
      organizationRepository.findOne.mockResolvedValue(existingOrg);

      const result = await service.isOrganizationNameAvailable('Taken Name');

      expect(result).toBe(false);
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      const mockPayload = { sub: 'user-1', type: 'refresh' };
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: true,
        organizationMemberships: [],
      } as any;

      jwtService.verify.mockReturnValue(mockPayload);
      userRepository.findOne.mockResolvedValue(mockUser);
      jwtService.sign.mockReturnValueOnce('new-access-token').mockReturnValueOnce('new-refresh-token');

      const result = await service.refreshToken('valid-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
    });

    it('should throw error for invalid token type', async () => {
      const mockPayload = { sub: 'user-1', type: 'access' };
      jwtService.verify.mockReturnValue(mockPayload);

      await expect(service.refreshToken('invalid-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw error for inactive user', async () => {
      const mockPayload = { sub: 'user-1', type: 'refresh' };
      const mockUser = { id: 'user-1', isActive: false } as any;

      jwtService.verify.mockReturnValue(mockPayload);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.refreshToken('token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw error if user not found', async () => {
      const mockPayload = { sub: 'user-1', type: 'refresh' };
      jwtService.verify.mockReturnValue(mockPayload);
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.refreshToken('token')).rejects.toThrow(UnauthorizedException);
    });

    it('should reject a refresh token whose tv is stale (revoked)', async () => {
      const mockPayload = { sub: 'user-1', type: 'refresh', tv: 0 };
      const mockUser = {
        id: 'user-1',
        isActive: true,
        tokenVersion: 1, // bumped after the token was issued
        organizationMemberships: [],
      } as any;
      jwtService.verify.mockReturnValue(mockPayload);
      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.refreshToken('token')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('createApiKey', () => {
    it('should create API key successfully', async () => {
      const createDto = {
        name: 'Test Key',
        organizationId: 'org-1',
        scopes: ['read:apis'],
      };

      const mockApiKey = { id: 'key-1', name: 'Test Key', keyPrefix: 'almyty_12' } as any;
      apiKeyRepository.create.mockReturnValue(mockApiKey);
      apiKeyRepository.save.mockResolvedValue(mockApiKey);

      const result = await service.createApiKey('user-1', createDto);

      expect(result.apiKey).toContain('almyty_');
      expect(result.keyData).toBe(mockApiKey);
      expect(apiKeyRepository.create).toHaveBeenCalled();
      expect(apiKeyRepository.save).toHaveBeenCalled();
    });
  });

  describe('revokeApiKey', () => {
    it('should revoke API key successfully', async () => {
      const mockApiKey = { id: 'key-1', userId: 'user-1', isActive: true } as any;
      apiKeyRepository.findOne.mockResolvedValue(mockApiKey);
      apiKeyRepository.save.mockResolvedValue({ ...mockApiKey, isActive: false } as any);

      await service.revokeApiKey('key-1', 'user-1');

      expect(mockApiKey.isActive).toBe(false);
      expect(apiKeyRepository.save).toHaveBeenCalled();
    });

    it('should throw error if API key not found', async () => {
      apiKeyRepository.findOne.mockResolvedValue(null);

      await expect(service.revokeApiKey('key-1', 'user-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getUserApiKeys', () => {
    it('should return user API keys', async () => {
      const mockKeys = [
        { id: 'key-1', name: 'Key 1' },
        { id: 'key-2', name: 'Key 2' },
      ] as any;

      apiKeyRepository.find.mockResolvedValue(mockKeys);

      const result = await service.getUserApiKeys('user-1');

      expect(result).toHaveLength(2);
      expect(apiKeyRepository.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('resetPassword', () => {
    it('should initiate password reset for existing user', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' } as any;
      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue(mockUser);

      await service.resetPassword('test@example.com');

      expect(userRepository.save).toHaveBeenCalled();
      expect(mockUser.resetPasswordToken).toBeDefined();
      expect(mockUser.resetPasswordExpires).toBeDefined();
    });

    it('should not reveal if user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await service.resetPassword('nonexistent@example.com');

      expect(userRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('confirmPasswordReset', () => {
    it('should reset password with valid token', async () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);
      const newPassword = 'NewSecurePassword123!';

      const mockUser = {
        id: 'user-1',
        resetPasswordToken: 'valid-token',
        resetPasswordExpires: futureDate,
      } as any;

      let savedUser: any;
      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockImplementation((user) => {
        savedUser = user;
        return Promise.resolve(user as any);
      });

      await service.confirmPasswordReset('valid-token', newPassword);

      expect(savedUser.resetPasswordToken).toBeNull();
      expect(savedUser.resetPasswordExpires).toBeNull();
      expect(userRepository.save).toHaveBeenCalled();

      // Verify new password was hashed
      expect(savedUser.passwordHash).toBeDefined();
      expect(savedUser.passwordHash).not.toBe(newPassword);
      expect(savedUser.tokenVersion).toBe(1); // revokes existing sessions

      // Verify the hash is valid
      const isPasswordValid = await bcrypt.compare(newPassword, savedUser.passwordHash);
      expect(isPasswordValid).toBe(true);
    });

    it('should throw error for expired token', async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      const mockUser = {
        id: 'user-1',
        resetPasswordToken: 'expired-token',
        resetPasswordExpires: pastDate,
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.confirmPasswordReset('expired-token', 'newPassword')).rejects.toThrow(BadRequestException);
    });

    it('should throw error for invalid token', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.confirmPasswordReset('invalid-token', 'newPassword')).rejects.toThrow(BadRequestException);
    });

    it('should reject empty/null tokens BEFORE hitting the DB (defense in depth)', async () => {
      // Regression: an empty token would `WHERE resetPasswordToken IS NULL`,
      // matching any user without a reset in flight. Today the null-expires
      // check catches this by accident — but the invariant is brittle, so
      // we now reject empty tokens up front.
      await expect(service.confirmPasswordReset('', 'newPassword')).rejects.toThrow(BadRequestException);
      await expect(service.confirmPasswordReset(null as any, 'newPassword')).rejects.toThrow(BadRequestException);
      await expect(service.confirmPasswordReset(undefined as any, 'newPassword')).rejects.toThrow(BadRequestException);
      // Critically: the DB should NOT be queried for these.
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => { // eslint-disable-line jest/no-done-callback
      jest.setTimeout(15000);
      const currentPassword = 'CurrentPassword123!';
      const newPassword = 'NewPassword456!';
      const passwordHash = await bcrypt.hash(currentPassword, 12);

      const mockUser = {
        id: 'user-1',
        passwordHash,
      } as any;

      let savedUser: any;
      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockImplementation((user) => {
        savedUser = user;
        return Promise.resolve(user as any);
      });

      await service.changePassword('user-1', currentPassword, newPassword);

      expect(userRepository.save).toHaveBeenCalled();

      // Verify new password was hashed
      expect(savedUser.passwordHash).toBeDefined();
      expect(savedUser.passwordHash).not.toBe(newPassword);
      expect(savedUser.tokenVersion).toBe(1); // revokes existing sessions
      expect(savedUser.passwordHash).not.toBe(passwordHash);

      // Verify new password validates correctly
      const isNewPasswordValid = await bcrypt.compare(newPassword, savedUser.passwordHash);
      expect(isNewPasswordValid).toBe(true);

      // Verify old password no longer works
      const isOldPasswordStillValid = await bcrypt.compare(currentPassword, savedUser.passwordHash);
      expect(isOldPasswordStillValid).toBe(false);
    });

    it('should throw error if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.changePassword('user-1', 'current', 'new')).rejects.toThrow(BadRequestException);
    });

    it('should throw error if current password is wrong', async () => {
      const correctPassword = 'CorrectPassword123!';
      const passwordHash = await bcrypt.hash(correctPassword, 12);

      const mockUser = {
        id: 'user-1',
        passwordHash,
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.changePassword('user-1', 'wrongPassword', 'newPassword')).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyEmail', () => {
    it('should verify email successfully', async () => {
      const mockUser = {
        id: 'user-1',
        verificationToken: 'valid-token',
        isVerified: false,
      } as any;

      userRepository.findOne.mockResolvedValue(mockUser);
      userRepository.save.mockResolvedValue({ ...mockUser, isVerified: true, verificationToken: null } as any);

      await service.verifyEmail('valid-token');

      expect(mockUser.isVerified).toBe(true);
      expect(mockUser.verificationToken).toBeNull();
      expect(userRepository.save).toHaveBeenCalled();
    });

    it('should throw error for invalid verification token', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyEmail('invalid-token')).rejects.toThrow(BadRequestException);
    });
  });
});