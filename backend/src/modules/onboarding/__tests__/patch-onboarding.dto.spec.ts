import { ValidationPipe } from '@nestjs/common';

import { PAGE_INTRO_TOPICS, PatchOnboardingDto } from '../dto/onboarding.dto';

/**
 * The same pipe options main.ts installs globally. A field without a
 * class-validator decorator is rejected as "should not exist", which is
 * how PATCH .../onboarding once refused the one field it was for.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: PatchOnboardingDto });

describe('PatchOnboardingDto', () => {
  it('accepts every page intro topic', async () => {
    for (const topic of PAGE_INTRO_TOPICS) {
      await expect(validate({ dismissIntro: topic })).resolves.toMatchObject({ dismissIntro: topic });
    }
  });

  it('rejects an intro name that is not a topic', async () => {
    await expect(validate({ dismissIntro: 'settings' })).rejects.toBeDefined();
  });

  it('accepts resetIntros and dismissed together', async () => {
    await expect(validate({ resetIntros: true, dismissed: false })).resolves.toMatchObject({
      resetIntros: true,
      dismissed: false,
    });
  });

  it('still rejects unknown fields', async () => {
    await expect(validate({ onboardingDismissedIntros: [] })).rejects.toBeDefined();
  });
});
