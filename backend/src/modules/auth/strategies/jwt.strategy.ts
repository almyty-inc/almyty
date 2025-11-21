import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities/user.entity';
import { JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<User> {
    // Only load organizationMemberships, skip apiKeys for performance
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: [
        'organizationMemberships',
        'organizationMemberships.organization',
      ],
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    // Add currentOrganizationId for easy access
    (user as any).currentOrganizationId = user.organizationMemberships?.[0]?.organizationId;

    // Add organizations array to match controller expectations (req.user.organizations)
    (user as any).organizations = user.organizationMemberships?.map(membership => ({
      id: membership.organizationId || membership.organization?.id,
      name: membership.organization?.name,
      role: membership.role,
    })) || [];

    return user;
  }
}