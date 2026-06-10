import { z } from 'zod'
import type { AssetSpec, AssetFormat } from './types'

// --- Brand ---

export const BrandTokensSchema = z.object({
  primaryColor: z.string(),
  accentColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().optional(),
  businessName: z.string(),
  voice: z.string(),
})

// --- Email ---

const EmailHeroSectionSchema = z.object({
  type: z.literal('hero'),
  headline: z.string(),
  subheadline: z.string().optional(),
  imageUrl: z.string().optional(),
  ctaLabel: z.string().optional(),
  ctaUrl: z.string().optional(),
})

const EmailBodySectionSchema = z.object({
  type: z.literal('body'),
  text: z.string(),
})

const EmailFeatureSectionSchema = z.object({
  type: z.literal('feature'),
  headline: z.string(),
  description: z.string(),
  imageUrl: z.string().optional(),
})

const EmailTestimonialSectionSchema = z.object({
  type: z.literal('testimonial'),
  quote: z.string(),
  author: z.string(),
  role: z.string().optional(),
  avatarUrl: z.string().optional(),
})

const EmailCtaSectionSchema = z.object({
  type: z.literal('cta'),
  label: z.string(),
  url: z.string(),
  subtext: z.string().optional(),
})

const EmailDividerSectionSchema = z.object({
  type: z.literal('divider'),
})

const EmailSectionSchema = z.discriminatedUnion('type', [
  EmailHeroSectionSchema,
  EmailBodySectionSchema,
  EmailFeatureSectionSchema,
  EmailTestimonialSectionSchema,
  EmailCtaSectionSchema,
  EmailDividerSectionSchema,
])

export const EmailContentSchema = z.object({
  subject: z.string(),
  preheader: z.string().optional(),
  sections: z.array(EmailSectionSchema),
})

// --- Image ---

const ImageBackgroundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('color'), value: z.string() }),
  z.object({ type: z.literal('gradient'), from: z.string(), to: z.string(), direction: z.string().optional() }),
  z.object({ type: z.literal('image'), url: z.string(), overlay: z.string().optional(), overlayOpacity: z.number().optional() }),
])

const ImageTextLayerSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number().optional(),
  fontWeight: z.enum(['normal', 'bold']).optional(),
  color: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
})

const ImageImageLayerSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  opacity: z.number().optional(),
})

const ImageShapeLayerSchema = z.object({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'circle', 'rounded-rect']),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fill: z.string().optional(),
  opacity: z.number().optional(),
})

const ImageLogoLayerSchema = z.object({
  type: z.literal('logo'),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
})

const ImageLayerSchema = z.discriminatedUnion('type', [
  ImageTextLayerSchema,
  ImageImageLayerSchema,
  ImageShapeLayerSchema,
  ImageLogoLayerSchema,
])

const ImageSlideSchema = z.object({
  background: ImageBackgroundSchema,
  layers: z.array(ImageLayerSchema),
})

export const ImageContentSchema = z.object({
  slides: z.array(ImageSlideSchema).min(1),
})

// --- Video ---

const VideoTextAnimationSceneSchema = z.object({
  type: z.literal('text-animation'),
  durationSeconds: z.number().positive(),
  headline: z.string(),
  subtext: z.string().optional(),
  animation: z.enum(['fade', 'slide-up', 'typewriter']).optional(),
  background: ImageBackgroundSchema.optional(),
})

const VideoImageRevealSceneSchema = z.object({
  type: z.literal('image-reveal'),
  durationSeconds: z.number().positive(),
  imageUrl: z.string(),
  caption: z.string().optional(),
})

const VideoSlideSceneSchema = z.object({
  type: z.literal('slide'),
  durationSeconds: z.number().positive(),
  slide: ImageSlideSchema,
})

const VideoCountdownSceneSchema = z.object({
  type: z.literal('countdown'),
  durationSeconds: z.number().positive(),
  from: z.number().int().positive(),
  label: z.string().optional(),
})

const VideoSceneSchema = z.discriminatedUnion('type', [
  VideoTextAnimationSceneSchema,
  VideoImageRevealSceneSchema,
  VideoSlideSceneSchema,
  VideoCountdownSceneSchema,
])

const VideoCaptionSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string(),
})

export const VideoContentSchema = z.object({
  durationSeconds: z.number().positive(),
  scenes: z.array(VideoSceneSchema).min(1),
  audioUrl: z.string().optional(),
  captions: z.array(VideoCaptionSchema).optional(),
  renderedUrl: z.string().optional(),
})

// --- Copy ---

export const CopyContentSchema = z.object({
  headline: z.string(),
  body: z.string(),
  hashtags: z.array(z.string()).optional(),
  platform: z.enum(['instagram', 'tiktok', 'x', 'linkedin', 'sms', 'email-subject']),
  characterCount: z.number().optional(),
})

// --- Approval ---

export const ApprovalEventSchema = z.object({
  assetId: z.string(),
  variantId: z.string().optional(),
  action: z.enum(['approved', 'rejected', 'edited', 'scheduled']),
  editedFields: z.array(z.string()).optional(),
  userId: z.string(),
  timestamp: z.string(),
})

export const ConversionMetricsSchema = z.object({
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  conversions: z.number().nonnegative(),
  ctr: z.number().nonnegative(),
  cvr: z.number().nonnegative(),
})

// --- Content map for discriminated parse ---

const AssetFormatValues = [
  'email',
  'image:feed',
  'image:story',
  'image:carousel',
  'video:reel',
  'video:feed',
  'copy:caption',
  'copy:headline',
  'copy:sms',
] as const

const ContentSchemaByFormat = {
  email: EmailContentSchema,
  'image:feed': ImageContentSchema,
  'image:story': ImageContentSchema,
  'image:carousel': ImageContentSchema,
  'video:reel': VideoContentSchema,
  'video:feed': VideoContentSchema,
  'copy:caption': CopyContentSchema,
  'copy:headline': CopyContentSchema,
  'copy:sms': CopyContentSchema,
} as const

const AssetSpecBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  campaignId: z.string().optional(),
  format: z.enum(AssetFormatValues),
  brand: BrandTokensSchema,
  status: z.enum(['draft', 'pending_review', 'approved', 'rejected', 'scheduled', 'published']),
  scheduledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * Validates an unknown value as an AssetSpec, including format-specific
 * content validation. Throws ZodError on invalid input.
 */
export function parseAssetSpec(raw: unknown): AssetSpec {
  const base = AssetSpecBaseSchema.parse(raw)
  const contentSchema = ContentSchemaByFormat[base.format]
  const content = contentSchema.parse((raw as Record<string, unknown>).content)
  return { ...base, content } as AssetSpec
}

/**
 * Safe parse — returns null instead of throwing.
 */
export function safeParseAssetSpec(raw: unknown): AssetSpec | null {
  try {
    return parseAssetSpec(raw)
  } catch {
    return null
  }
}
