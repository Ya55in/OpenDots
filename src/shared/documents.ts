import { z } from 'zod';
export const documentFormats = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'md',
  'txt',
  'csv',
] as const;
export const documentSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    subtitle: z.string().max(300).default(''),
    markdown: z.string().trim().min(1).max(100000),
    formats: z.array(z.enum(documentFormats)).min(1).max(7),
    style: z.enum(['executive', 'minimal', 'proposal']).default('executive'),
    brand: z.string().max(60).default(''),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    footer: z.string().max(120).default(''),
  })
  .strict();
export type DocumentInput = z.infer<typeof documentSchema>;
export type DocumentFormat = (typeof documentFormats)[number];
export const artifactSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  spaceId: z.string().regex(/^[\w-]+$/),
  name: z.string(),
  size: z.number(),
  provider: z.enum(['local', 'drive']),
  downloadUrl: z.string(),
});
export const documentResultSchema = z.object({
  files: z.array(artifactSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string()).optional(),
});
export type DocumentResult = z.infer<typeof documentResultSchema>;
