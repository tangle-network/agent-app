// src/assets/schema.ts
import { z } from "zod";
var BrandTokensSchema = z.object({
  primaryColor: z.string(),
  accentColor: z.string(),
  textColor: z.string(),
  fontFamily: z.string(),
  logoUrl: z.string().optional(),
  businessName: z.string(),
  voice: z.string()
});
var EmailHeroSectionSchema = z.object({
  type: z.literal("hero"),
  headline: z.string(),
  subheadline: z.string().optional(),
  imageUrl: z.string().optional(),
  ctaLabel: z.string().optional(),
  ctaUrl: z.string().optional()
});
var EmailBodySectionSchema = z.object({
  type: z.literal("body"),
  text: z.string()
});
var EmailFeatureSectionSchema = z.object({
  type: z.literal("feature"),
  headline: z.string(),
  description: z.string(),
  imageUrl: z.string().optional()
});
var EmailTestimonialSectionSchema = z.object({
  type: z.literal("testimonial"),
  quote: z.string(),
  author: z.string(),
  role: z.string().optional(),
  avatarUrl: z.string().optional()
});
var EmailCtaSectionSchema = z.object({
  type: z.literal("cta"),
  label: z.string(),
  url: z.string(),
  subtext: z.string().optional()
});
var EmailDividerSectionSchema = z.object({
  type: z.literal("divider")
});
var EmailSectionSchema = z.discriminatedUnion("type", [
  EmailHeroSectionSchema,
  EmailBodySectionSchema,
  EmailFeatureSectionSchema,
  EmailTestimonialSectionSchema,
  EmailCtaSectionSchema,
  EmailDividerSectionSchema
]);
var EmailContentSchema = z.object({
  subject: z.string(),
  preheader: z.string().optional(),
  sections: z.array(EmailSectionSchema)
});
var ImageBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), value: z.string() }),
  z.object({ type: z.literal("gradient"), from: z.string(), to: z.string(), direction: z.string().optional() }),
  z.object({ type: z.literal("image"), url: z.string(), overlay: z.string().optional(), overlayOpacity: z.number().optional() })
]);
var ImageTextLayerSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  fontSize: z.number().optional(),
  fontWeight: z.enum(["normal", "bold"]).optional(),
  color: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional()
});
var ImageImageLayerSchema = z.object({
  type: z.literal("image"),
  url: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  opacity: z.number().optional()
});
var ImageShapeLayerSchema = z.object({
  type: z.literal("shape"),
  shape: z.enum(["rect", "circle", "rounded-rect"]),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fill: z.string().optional(),
  opacity: z.number().optional()
});
var ImageLogoLayerSchema = z.object({
  type: z.literal("logo"),
  x: z.number(),
  y: z.number(),
  width: z.number().optional()
});
var ImageLayerSchema = z.discriminatedUnion("type", [
  ImageTextLayerSchema,
  ImageImageLayerSchema,
  ImageShapeLayerSchema,
  ImageLogoLayerSchema
]);
var ImageSlideSchema = z.object({
  background: ImageBackgroundSchema,
  layers: z.array(ImageLayerSchema)
});
var ImageContentSchema = z.object({
  slides: z.array(ImageSlideSchema).min(1)
});
var VideoTextAnimationSceneSchema = z.object({
  type: z.literal("text-animation"),
  durationSeconds: z.number().positive(),
  headline: z.string(),
  subtext: z.string().optional(),
  animation: z.enum(["fade", "slide-up", "typewriter"]).optional(),
  background: ImageBackgroundSchema.optional()
});
var VideoImageRevealSceneSchema = z.object({
  type: z.literal("image-reveal"),
  durationSeconds: z.number().positive(),
  imageUrl: z.string(),
  caption: z.string().optional()
});
var VideoSlideSceneSchema = z.object({
  type: z.literal("slide"),
  durationSeconds: z.number().positive(),
  slide: ImageSlideSchema
});
var VideoCountdownSceneSchema = z.object({
  type: z.literal("countdown"),
  durationSeconds: z.number().positive(),
  from: z.number().int().positive(),
  label: z.string().optional()
});
var VideoSceneSchema = z.discriminatedUnion("type", [
  VideoTextAnimationSceneSchema,
  VideoImageRevealSceneSchema,
  VideoSlideSceneSchema,
  VideoCountdownSceneSchema
]);
var VideoCaptionSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string()
});
var VideoContentSchema = z.object({
  durationSeconds: z.number().positive(),
  scenes: z.array(VideoSceneSchema).min(1),
  audioUrl: z.string().optional(),
  captions: z.array(VideoCaptionSchema).optional(),
  renderedUrl: z.string().optional()
});
var CopyContentSchema = z.object({
  headline: z.string(),
  body: z.string(),
  hashtags: z.array(z.string()).optional(),
  platform: z.enum(["instagram", "tiktok", "x", "linkedin", "sms", "email-subject"]),
  characterCount: z.number().optional()
});
var ApprovalEventSchema = z.object({
  assetId: z.string(),
  variantId: z.string().optional(),
  action: z.enum(["approved", "rejected", "edited", "scheduled"]),
  editedFields: z.array(z.string()).optional(),
  userId: z.string(),
  timestamp: z.string()
});
var ConversionMetricsSchema = z.object({
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative(),
  conversions: z.number().nonnegative(),
  ctr: z.number().nonnegative(),
  cvr: z.number().nonnegative()
});
var AssetFormatValues = [
  "email",
  "image:feed",
  "image:story",
  "image:carousel",
  "video:reel",
  "video:feed",
  "copy:caption",
  "copy:headline",
  "copy:sms"
];
var ContentSchemaByFormat = {
  email: EmailContentSchema,
  "image:feed": ImageContentSchema,
  "image:story": ImageContentSchema,
  "image:carousel": ImageContentSchema,
  "video:reel": VideoContentSchema,
  "video:feed": VideoContentSchema,
  "copy:caption": CopyContentSchema,
  "copy:headline": CopyContentSchema,
  "copy:sms": CopyContentSchema
};
var AssetCreatePayloadSchema = z.union([
  z.object({ format: z.literal("email"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: EmailContentSchema }),
  z.object({ format: z.literal("image:feed"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: ImageContentSchema }),
  z.object({ format: z.literal("image:story"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: ImageContentSchema }),
  z.object({ format: z.literal("image:carousel"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: ImageContentSchema }),
  z.object({ format: z.literal("video:reel"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: VideoContentSchema }),
  z.object({ format: z.literal("video:feed"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: VideoContentSchema }),
  z.object({ format: z.literal("copy:caption"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: CopyContentSchema }),
  z.object({ format: z.literal("copy:headline"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: CopyContentSchema }),
  z.object({ format: z.literal("copy:sms"), campaignId: z.string().optional(), brand: BrandTokensSchema, content: CopyContentSchema })
]);
var assetCreateJsonSchema = {
  ...z.toJSONSchema(AssetCreatePayloadSchema),
  $id: "https://tangle.tools/schemas/asset-create.json",
  title: "AssetCreate",
  description: "A model-produced marketing asset payload before host metadata is assigned."
};
var AssetSpecBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  campaignId: z.string().optional(),
  format: z.enum(AssetFormatValues),
  brand: BrandTokensSchema,
  status: z.enum(["draft", "pending_review", "approved", "rejected", "scheduled", "published"]),
  scheduledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
function parseAssetSpec(raw) {
  const base = AssetSpecBaseSchema.parse(raw);
  const contentSchema = ContentSchemaByFormat[base.format];
  const content = contentSchema.parse(raw.content);
  return { ...base, content };
}
function safeParseAssetSpec(raw) {
  try {
    return parseAssetSpec(raw);
  } catch {
    return null;
  }
}
export {
  ApprovalEventSchema,
  BrandTokensSchema,
  ConversionMetricsSchema,
  CopyContentSchema,
  EmailContentSchema,
  ImageContentSchema,
  VideoContentSchema,
  assetCreateJsonSchema,
  parseAssetSpec,
  safeParseAssetSpec
};
//# sourceMappingURL=index.js.map