import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { AuthService, JwtPayload, AuthTokens } from './auth.service';
import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { ReferralsService } from '../referrals/referrals.service';
import { CaptchaService } from './captcha.service';

// Unmock bcrypt from global setup to test actual hashing
jest.unmock('bcryptjs');

describe('AuthService', () => {
  let service: AuthService;
  let mailService: any;
  let userRepository: jest.Mocked<Repository<User>>;
  let apiKeyRepository: jest.Mocked<Repository<ApiKey>>;
  let organizationRepository: jest.Mocked<Repository<Organization>>;
  let userOrganizationRepository: jest.Mocked<Repository<UserOrganization>>;
  let jwtService: jest.Mocked<JwtService>;
  let referralsService: any;
  let captchaService: any;

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
        {
          provide: MailService,
          useValue: { sendPasswordReset: jest.fn().mockResolvedValue(true), sendInvitation: jest.fn().mockResolvedValue(true), sendEmailVerification: jest.fn().mockResolvedValue(true), send: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: ReferralsService,
          useValue: { attributeSignup: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: CaptchaService,
          // Disabled by default (ships dark) so existing register tests are
          // unaffected; individual tests flip isEnabled/verify as needed.
          useValue: {
            isEnabled: jest.fn().mockReturnValue(false),
            verify: jest.fn().mockResolvedValue(true),
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
    mailService = module.get(MailService);
    referralsService = module.get(ReferralsService);
    captchaService = module.get(CaptchaService);

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
      // Sequence: 1) duplicate-email check, 2) fire-and-forget
      // verification-email lookup (register kicks it off before token
      // generation), 3) generateTokens re-reads the user with orgs.
      userRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(userWithOrgs);

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

    // ── Referral attribution hook (additive, post-transaction) ──────────

    function mockSuccessfulRegistration() {
      const mockOrganization = {
        id: 'org-123',
        name: createUserDto.organizationName,
        plan: 'free',
        isActive: true,
      } as Organization;
      userRepository.create.mockImplementation((userData) => userData as User);
      userRepository.save.mockImplementation((user) =>
        Promise.resolve({ ...user, id: 'user-123' } as User),
      );
      organizationRepository.create.mockReturnValue(mockOrganization);
      organizationRepository.save.mockResolvedValue(mockOrganization);
      userOrganizationRepository.create.mockReturnValue({} as UserOrganization);
      userOrganizationRepository.save.mockResolvedValue({} as UserOrganization);
      jwtService.sign.mockReturnValue('mock-token');
      const userWithOrgs = {
        id: 'user-123',
        email: createUserDto.email,
        organizationMemberships: [],
        hasPermissionInOrganization: jest.fn().mockReturnValue(true),
      } as any;
      // Sequence: 1) duplicate-email check, 2) fire-and-forget
      // verification-email lookup (register kicks it off before token
      // generation), 3) generateTokens re-reads the user with orgs.
      userRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(userWithOrgs);
      organizationRepository.findOne.mockResolvedValue(null); // org name available
    }

    it('attributes the signup when a referral code is present in the context', async () => {
      mockSuccessfulRegistration();

      await service.register(createUserDto, { referralCode: 'ABCD2345', ipAddress: '203.0.113.9' });

      expect(referralsService.attributeSignup).toHaveBeenCalledWith({
        userId: 'user-123',
        organizationId: 'org-123',
        email: createUserDto.email,
        referralCode: 'ABCD2345',
        ipAddress: '203.0.113.9',
      });
    });

    it('does not attribute when no referral code is provided', async () => {
      mockSuccessfulRegistration();

      await service.register(createUserDto);

      expect(referralsService.attributeSignup).not.toHaveBeenCalled();
    });

    it('still registers successfully when attribution throws', async () => {
      mockSuccessfulRegistration();
      referralsService.attributeSignup.mockRejectedValueOnce(new Error('referral system down'));

      const result = await service.register(createUserDto, { referralCode: 'ABCD2345' });

      expect(result.accessToken).toBe('mock-token');
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
      userRepo.findOne.mockResolvedValueOnce(null); // fire-and-forget verification lookup
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

    // ── Signup abuse protection ─────────────────────────────────────────

    describe('email normalization + dedupe', () => {
      it('dedupes gmail dot-injection aliases against an existing account', async () => {
        // A user already exists under the canonical normalizedEmail; the
        // dotted alias must be rejected as a duplicate.
        const dotted: CreateUserDto = { ...createUserDto, email: 'f.o.o@gmail.com' };
        userRepository.findOne.mockResolvedValue({ id: 'existing' } as User);

        await expect(service.register(dotted))
          .rejects
          .toThrow(new BadRequestException('User with this email already exists'));

        // The dedupe lookup must include the normalized form.
        const call = userRepository.findOne.mock.calls[0][0] as any;
        expect(call.where).toEqual(
          expect.arrayContaining([
            { email: 'f.o.o@gmail.com' },
            { normalizedEmail: 'foo@gmail.com' },
          ]),
        );
      });

      it('stores the normalized email (dots + tag stripped) on a new account', async () => {
        const tagged: CreateUserDto = { ...createUserDto, email: 'f.o.o+promo@gmail.com' };
        organizationRepository.findOne.mockResolvedValue(null);
        organizationRepository.create.mockReturnValue({ id: 'org-1' } as Organization);
        organizationRepository.save.mockResolvedValue({ id: 'org-1' } as Organization);
        userOrganizationRepository.create.mockReturnValue({} as UserOrganization);
        userOrganizationRepository.save.mockResolvedValue({} as UserOrganization);
        jwtService.sign.mockReturnValue('mock-token');

        let created: any;
        userRepository.create.mockImplementation((u) => { created = u; return u as User; });
        userRepository.save.mockImplementation((u) => Promise.resolve({ ...u, id: 'user-1' } as User));
        userRepository.findOne
          .mockResolvedValueOnce(null) // dedupe check
          .mockResolvedValueOnce(null) // verification lookup
          .mockResolvedValueOnce({ id: 'user-1', organizationMemberships: [] } as any);

        await service.register(tagged);

        expect(created.email).toBe('f.o.o+promo@gmail.com'); // raw preserved
        expect(created.normalizedEmail).toBe('foo@gmail.com'); // canonicalized
      });
    });

    describe('disposable email rejection', () => {
      it('rejects a known disposable domain before any DB write', async () => {
        const disposable: CreateUserDto = { ...createUserDto, email: 'bot@mailinator.com' };

        await expect(service.register(disposable))
          .rejects
          .toThrow(/Disposable email addresses are not allowed/);

        expect(userRepository.findOne).not.toHaveBeenCalled();
      });

      it('accepts a normal domain', async () => {
        mockSuccessfulRegistration();
        const result = await service.register(createUserDto);
        expect(result.accessToken).toBe('mock-token');
      });
    });

    describe('CAPTCHA gate', () => {
      it('is a no-op when unconfigured (register proceeds)', async () => {
        captchaService.isEnabled.mockReturnValue(false);
        mockSuccessfulRegistration();

        const result = await service.register(createUserDto);

        expect(result.accessToken).toBe('mock-token');
        expect(captchaService.verify).not.toHaveBeenCalled();
      });

      it('rejects when enabled and the token is missing/invalid', async () => {
        captchaService.isEnabled.mockReturnValue(true);
        captchaService.verify.mockResolvedValue(false);

        await expect(service.register({ ...createUserDto, captchaToken: 'bad' }))
          .rejects
          .toThrow(new BadRequestException('CAPTCHA verification failed'));

        // Rejected before touching the DB.
        expect(userRepository.findOne).not.toHaveBeenCalled();
      });

      it('proceeds when enabled and the token verifies', async () => {
        captchaService.isEnabled.mockReturnValue(true);
        captchaService.verify.mockResolvedValue(true);
        mockSuccessfulRegistration();

        const result = await service.register({ ...createUserDto, captchaToken: 'good' });

        expect(result.accessToken).toBe('mock-token');
        expect(captchaService.verify).toHaveBeenCalledWith('good', undefined);
      });
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
        isVerified: true,
        verifiedAt: new Date(),
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
        relations: { organizationMemberships: { organization: true } },
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
        isVerified: true,
        verifiedAt: new Date(),
        passwordHash,
        organizationMemberships: [],
      } as User;

      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.validateUser('test@example.com', testPassword);

      expect(result).toBe(mockUser);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
        relations: { organizationMemberships: { organization: true } },
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
        relations: { organizationMemberships: { organization: true } },
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
        relations: { user: { organizationMemberships: { organization: true } }, organization: true },
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
      expect(mailService.sendPasswordReset).toHaveBeenCalledWith('test@example.com', expect.any(String));
    });

    it('should not reveal if user does not exist', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await service.resetPassword('nonexistent@example.com');

      expect(userRepository.save).not.toHaveBeenCalled();
      expect(mailService.sendPasswordReset).not.toHaveBeenCalled();
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
      // The password must NOT be changed when the current one is wrong.
      expect(userRepository.save).not.toHaveBeenCalled();
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

    // Real signed-JWT roundtrip — the path the emailed link actually uses.
    // Mints a genuine token and verifies it end to end (no verify() mock),
    // guarding the sign -> verify -> verifiedAt chain and its security checks.
    describe('signed-token roundtrip (integration)', () => {
      const { JwtService: RealJwt } = require('@nestjs/jwt');
      const realJwt = new RealJwt({ secret: 'roundtrip-test-secret' });
      const mint = (claims: Record<string, any>) =>
        realJwt.sign(claims, { expiresIn: '7d' });

      beforeEach(() => {
        jwtService.verify.mockImplementation(((t: string) => realJwt.verify(t)) as any);
      });

      it('a real email_verify token flips verifiedAt and persists', async () => {
        const user = { id: 'user-9', email: 'ava@northwind.ai', verifiedAt: null, isVerified: false } as any;
        userRepository.findOne.mockResolvedValue(user);
        userRepository.save.mockImplementation(async (u: any) => u);

        const token = mint({ sub: 'user-9', email: 'ava@northwind.ai', purpose: 'email_verify' });
        await service.verifyEmail(token);

        expect(user.verifiedAt).toBeInstanceOf(Date);
        expect(userRepository.save).toHaveBeenCalled();
      });

      it('rejects a token whose purpose is not email_verify', async () => {
        const user = { id: 'user-9', email: 'ava@northwind.ai', verifiedAt: null } as any;
        // Faithful: the DB-token fallback (findOne by verificationToken) never
        // matches a JWT — only the id lookup returns the user.
        userRepository.findOne.mockImplementation(async ({ where }: any) =>
          where?.id === 'user-9' ? user : null);
        const token = mint({ sub: 'user-9', email: 'ava@northwind.ai', purpose: 'password_reset' });
        await expect(service.verifyEmail(token)).rejects.toThrow(BadRequestException);
        expect(user.verifiedAt).toBeNull();
      });

      it('rejects a token minted for a different email than the user now has', async () => {
        const user = { id: 'user-9', email: 'new@northwind.ai', verifiedAt: null } as any;
        userRepository.findOne.mockImplementation(async ({ where }: any) =>
          where?.id === 'user-9' ? user : null);
        const token = mint({ sub: 'user-9', email: 'old@northwind.ai', purpose: 'email_verify' });
        await expect(service.verifyEmail(token)).rejects.toThrow(BadRequestException);
        expect(user.verifiedAt).toBeNull();
      });
    });
  });

/**
 * Email verification flow (verifiedAt + signed token link). Uses direct
 * construction with per-test mocks — the flow touches only the user
 * repository, JwtService, and MailService.
 */
describe('AuthService email verification', () => {
  function makeDirect(overrides: { notifications?: any } = {}) {
    const userRepo: any = {
      findOne: jest.fn(),
      create: jest.fn((d: any) => d),
      save: jest.fn(async (u: any) => u),
      manager: { transaction: jest.fn() },
    };
    const orgRepo: any = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(), save: jest.fn() };
    const jwt: any = { sign: jest.fn().mockReturnValue('signed-token'), verify: jest.fn() };
    const mail: any = { sendEmailVerification: jest.fn().mockResolvedValue(true) };
    const audit: any = { log: jest.fn().mockResolvedValue(null) };
    const referrals: any = { attributeSignup: jest.fn().mockResolvedValue(null) };
    // Disabled-by-default CAPTCHA so register side-effect tests are unaffected.
    const captcha: any = { isEnabled: jest.fn().mockReturnValue(false), verify: jest.fn().mockResolvedValue(true) };
    const svc = new AuthService(
      userRepo,
      {} as any,
      orgRepo,
      {} as any,
      jwt,
      audit,
      mail,
      referrals,
      captcha,
      overrides.notifications,
    );
    return { svc, userRepo, orgRepo, jwt, mail };
  }

  describe('verifyEmail', () => {
    it('verifies via a signed token, stamping verifiedAt and clearing the legacy token', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      const user: any = {
        id: 'u1',
        email: 'a@example.com',
        isVerified: false,
        verifiedAt: null,
        verificationToken: 'legacy',
      };
      jwt.verify.mockReturnValue({ sub: 'u1', email: 'a@example.com', purpose: 'email_verify' });
      userRepo.findOne.mockResolvedValue(user);

      await svc.verifyEmail('signed-token');

      expect(user.isVerified).toBe(true);
      expect(user.verifiedAt).toBeInstanceOf(Date);
      expect(user.verificationToken).toBeNull();
      expect(userRepo.save).toHaveBeenCalledWith(user);
    });

    it('rejects a signed token bound to a different email address', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      jwt.verify.mockReturnValue({ sub: 'u1', email: 'old@example.com', purpose: 'email_verify' });
      userRepo.findOne.mockResolvedValue({ id: 'u1', email: 'new@example.com' });

      await expect(svc.verifyEmail('signed-token')).rejects.toThrow(BadRequestException);
    });

    it('falls back to the legacy DB-token path when the value is not a JWT', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      jwt.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });
      const user: any = { id: 'u1', isVerified: false, verifiedAt: null, verificationToken: 'db-token' };
      userRepo.findOne.mockResolvedValue(user);

      await svc.verifyEmail('db-token');

      expect(userRepo.findOne).toHaveBeenCalledWith({ where: { verificationToken: 'db-token' } });
      expect(user.verifiedAt).toBeInstanceOf(Date);
      expect(user.isVerified).toBe(true);
    });

    it('rejects empty and unknown tokens', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      await expect(svc.verifyEmail('')).rejects.toThrow(BadRequestException);

      jwt.verify.mockImplementation(() => {
        throw new Error('bad');
      });
      userRepo.findOne.mockResolvedValue(null);
      await expect(svc.verifyEmail('nope')).rejects.toThrow(BadRequestException);
    });
  });

  describe('requestEmailVerification', () => {
    it('mints a purpose-scoped 7d token and emails it to unverified users', async () => {
      const { svc, userRepo, jwt, mail } = makeDirect();
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        firstName: 'Ada',
        isVerified: false,
        verifiedAt: null,
      });

      const result = await svc.requestEmailVerification('u1');

      expect(result.alreadyVerified).toBe(false);
      expect(jwt.sign).toHaveBeenCalledWith(
        { sub: 'u1', email: 'a@example.com', purpose: 'email_verify' },
        { expiresIn: '7d' },
      );
      expect(mail.sendEmailVerification).toHaveBeenCalledWith('a@example.com', 'signed-token', 'Ada');
    });

    it('is a no-op for already-verified users', async () => {
      const { svc, userRepo, mail } = makeDirect();
      userRepo.findOne.mockResolvedValue({ id: 'u1', email: 'a@example.com', verifiedAt: new Date() });

      const result = await svc.requestEmailVerification('u1');

      expect(result.alreadyVerified).toBe(true);
      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });
  });

  describe('email-verification enforcement on login', () => {
    it('rejects an unverified user with EMAIL_NOT_VERIFIED and issues no token', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      const passwordHash = await bcrypt.hash('Password123!', 4);
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        passwordHash,
        isActive: true,
        isVerified: false,
        verifiedAt: null,
        organizationMemberships: [],
      });

      // Correct password but unverified -> specific ForbiddenException.
      let thrown: any;
      try {
        await svc.validateUser('a@example.com', 'Password123!');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      const resp: any = thrown.getResponse();
      expect(resp.code).toBe('EMAIL_NOT_VERIFIED');
      expect(resp.email).toBe('a@example.com');
      // login() goes through validateUser, so it must reject the same way
      // and never mint a token.
      await expect(
        svc.login({ email: 'a@example.com', password: 'Password123!' } as any),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('does not reveal verification state when the password is wrong', async () => {
      const { svc, userRepo } = makeDirect();
      const passwordHash = await bcrypt.hash('Password123!', 4);
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        passwordHash,
        isActive: true,
        isVerified: false,
        verifiedAt: null,
        organizationMemberships: [],
      });

      // Wrong password short-circuits to null before the verification gate,
      // so an attacker cannot use the specific error as an oracle.
      const user = await svc.validateUser('a@example.com', 'WrongPassword!');
      expect(user).toBeNull();
    });

    it('lets a verified user log in normally (founder / existing base unaffected)', async () => {
      const { svc, userRepo, jwt } = makeDirect();
      const passwordHash = await bcrypt.hash('Password123!', 4);
      const verified = {
        id: 'founder',
        email: 'founder@almyty.com',
        firstName: 'Fran',
        lastName: 'B',
        passwordHash,
        isActive: true,
        isVerified: true,
        verifiedAt: new Date('2024-01-01'),
        tokenVersion: 0,
        organizationMemberships: [],
      };
      userRepo.findOne.mockResolvedValue(verified);

      const user = await svc.validateUser('founder@almyty.com', 'Password123!');
      expect(user).not.toBeNull();
      expect(user!.id).toBe('founder');

      const tokens = await svc.login({ email: 'founder@almyty.com', password: 'Password123!' } as any);
      expect(tokens.accessToken).toBeTruthy();
      expect(jwt.sign).toHaveBeenCalled();
    });

    it('lets a legacy verified user (verifiedAt set, isVerified false) log in', async () => {
      const { svc, userRepo } = makeDirect();
      const passwordHash = await bcrypt.hash('Password123!', 4);
      userRepo.findOne.mockResolvedValue({
        id: 'legacy',
        email: 'legacy@almyty.com',
        passwordHash,
        isActive: true,
        isVerified: false,
        verifiedAt: new Date('2023-06-01'),
        organizationMemberships: [],
      });

      const user = await svc.validateUser('legacy@almyty.com', 'Password123!');
      expect(user).not.toBeNull();
    });
  });

  describe('requestEmailVerificationByEmail (unauthenticated resend)', () => {
    it('sends a fresh link for an unverified account', async () => {
      const { svc, userRepo, jwt, mail } = makeDirect();
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        firstName: 'Ada',
        isVerified: false,
        verifiedAt: null,
      });
      jwt.sign.mockReturnValue('verify-token');

      await svc.requestEmailVerificationByEmail('a@example.com');

      expect(mail.sendEmailVerification).toHaveBeenCalledWith('a@example.com', 'verify-token', 'Ada');
    });

    it('no-ops (no mail) for an already-verified account', async () => {
      const { svc, userRepo, mail } = makeDirect();
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        email: 'a@example.com',
        isVerified: true,
        verifiedAt: new Date(),
      });

      await svc.requestEmailVerificationByEmail('a@example.com');

      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });

    it('no-ops (no mail) for an unknown address — no enumeration oracle', async () => {
      const { svc, userRepo, mail } = makeDirect();
      userRepo.findOne.mockResolvedValue(null);

      await svc.requestEmailVerificationByEmail('nobody@example.com');

      expect(mail.sendEmailVerification).not.toHaveBeenCalled();
    });
  });

  describe('register side-effects', () => {
    it('sends the verification email and emits account.welcome', async () => {
      const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
      const { svc, userRepo, jwt, mail } = makeDirect({ notifications });

      const savedUser: any = {
        id: 'user-123',
        email: 'new@example.com',
        firstName: 'New',
        lastName: 'User',
        isVerified: false,
        verifiedAt: null,
        tokenVersion: 0,
      };
      userRepo.manager.transaction.mockImplementation(async (cb: any) =>
        cb({
          create: (_c: any, d: any) => d,
          save: async (c: any, e: any) => {
            const name = c?.name ?? '';
            if (name === 'User') return savedUser;
            if (name === 'Organization') return { id: 'org-123', ...e };
            return e;
          },
        }),
      );
      userRepo.findOne
        .mockResolvedValueOnce(null) // duplicate-email check
        .mockResolvedValueOnce(savedUser) // verification lookup
        .mockResolvedValueOnce({
          ...savedUser,
          organizationMemberships: [],
          hasPermissionInOrganization: jest.fn().mockReturnValue(true),
        }); // generateTokens

      await svc.register({
        email: 'new@example.com',
        password: 'Password123!',
        firstName: 'New',
        lastName: 'User',
        organizationName: 'NewOrg',
      } as any);
      await new Promise((r) => setImmediate(r));

      expect(mail.sendEmailVerification).toHaveBeenCalledWith('new@example.com', 'signed-token', 'New');
      expect(notifications.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'account.welcome',
          organizationId: 'org-123',
          userIds: ['user-123'],
          email: expect.objectContaining({ template: 'account.welcome' }),
        }),
      );
      expect(jwt.sign).toHaveBeenCalled();
    });
  });
});
});