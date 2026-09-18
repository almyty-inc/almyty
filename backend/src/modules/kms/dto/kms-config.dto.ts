import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

const CMK_ARN_PATTERN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[\w-]+$/;

/**
 * Attach the customer-managed CMK for the caller's org. `cmkArn` must look
 * like a KMS key ARN; the region is derived from it when omitted.
 */
export class SetCmkDto {
  @Matches(CMK_ARN_PATTERN, {
    message: 'cmkArn must be a valid AWS KMS key ARN',
  })
  cmkArn: string;

  @IsOptional()
  @IsString()
  awsRegion?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Rotate the org onto a fresh DEK. Omit `cmkArn` to rotate the DEK under the
 * CMK already configured; supply one to move to a different CMK at the same
 * time. Either way the outgoing wrapped DEK is retained, so values sealed
 * under it stay readable.
 */
export class RotateCmkDto {
  @IsOptional()
  @Matches(CMK_ARN_PATTERN, {
    message: 'cmkArn must be a valid AWS KMS key ARN',
  })
  cmkArn?: string;

  @IsOptional()
  @IsString()
  awsRegion?: string;
}

export class SetKmsEnabledDto {
  @IsBoolean()
  enabled: boolean;
}
