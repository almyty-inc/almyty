/**
 * The limits every multipart route hands multer.
 *
 * multer (busboy underneath) caps a file's size only when told to, and
 * caps the ordinary form fields beside it not at all: any number of them,
 * up to 1 MB each, all collected into `req.body` in memory before the
 * handler runs. A signed-in member could post a few thousand fields and
 * hold gigabytes on a pod that peaks around 286 MB. No upload here takes
 * more than one file and a handful of fields.
 *
 * Every FileInterceptor and MulterModule registration passes these; a
 * source guard (upload-limits.guard.spec.ts) holds it there.
 */
export const MAX_UPLOAD_FIELDS = 20;
export const MAX_UPLOAD_FIELD_BYTES = 1024 * 1024;

export interface UploadLimits {
  fileSize: number;
  files: number;
  fields: number;
  fieldSize: number;
  parts: number;
}

export function uploadLimits(fileSize: number): UploadLimits {
  return {
    fileSize,
    files: 1,
    fields: MAX_UPLOAD_FIELDS,
    fieldSize: MAX_UPLOAD_FIELD_BYTES,
    parts: MAX_UPLOAD_FIELDS + 1,
  };
}
