/** Define brand identity tokens including colors, font, logo, business name, and voice */
export interface BrandTokens {
  primaryColor: string
  accentColor: string
  textColor: string
  fontFamily: string
  logoUrl?: string
  businessName: string
  voice: string
}

/** Define valid asset format strings for various media and copy types */
export type AssetFormat =
  | 'email'
  | 'image:feed'
  | 'image:story'
  | 'image:carousel'
  | 'video:reel'
  | 'video:feed'
  | 'copy:caption'
  | 'copy:headline'
  | 'copy:sms'

/** Define possible states representing the lifecycle status of an asset */
export type AssetStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'published'

// --- Email ---

/** Define the structure for a hero section in an email with headline, image, and call-to-action fields */
export interface EmailHeroSection {
  type: 'hero'
  headline: string
  subheadline?: string
  imageUrl?: string
  ctaLabel?: string
  ctaUrl?: string
}

/** Define the structure for the body section of an email containing plain text content */
export interface EmailBodySection {
  type: 'body'
  text: string
}

/** Define a feature section with headline, description, and optional image for email content */
export interface EmailFeatureSection {
  type: 'feature'
  headline: string
  description: string
  imageUrl?: string
}

/** Define the structure for an email testimonial section with quote, author, and optional details */
export interface EmailTestimonialSection {
  type: 'testimonial'
  quote: string
  author: string
  role?: string
  avatarUrl?: string
}

/** Define a call-to-action section with label, URL, and optional subtext for email content */
export interface EmailCtaSection {
  type: 'cta'
  label: string
  url: string
  subtext?: string
}

/** Define a section representing a divider in an email layout */
export interface EmailDividerSection {
  type: 'divider'
}

/** Define a union type representing different sections of an email template */
export type EmailSection =
  | EmailHeroSection
  | EmailBodySection
  | EmailFeatureSection
  | EmailTestimonialSection
  | EmailCtaSection
  | EmailDividerSection

/** Define the structure for email content including subject, optional preheader, and sections */
export interface EmailContent {
  subject: string
  preheader?: string
  sections: EmailSection[]
}

// --- Image ---

/** Define image layer categories for text, image, shape, or logo elements */
export type ImageLayerType = 'text' | 'image' | 'shape' | 'logo'

/** Define properties for a text layer with position, style, and alignment options in an image */
export interface ImageTextLayer {
  type: 'text'
  text: string
  fontSize?: number
  fontWeight?: 'normal' | 'bold'
  color?: string
  x: number
  y: number
  width?: number
  align?: 'left' | 'center' | 'right'
}

/** Define properties for an image layer including position, size, URL, and optional opacity */
export interface ImageImageLayer {
  type: 'image'
  url: string
  x: number
  y: number
  width: number
  height: number
  opacity?: number
}

/** Define properties for a shape layer representing rectangular or circular image elements */
export interface ImageShapeLayer {
  type: 'shape'
  shape: 'rect' | 'circle' | 'rounded-rect'
  x: number
  y: number
  width: number
  height: number
  fill?: string
  opacity?: number
}

/** Define properties for positioning and sizing a logo image layer in a layout */
export interface ImageLogoLayer {
  type: 'logo'
  x: number
  y: number
  width?: number
}

/** Resolve a union type representing different kinds of image layers */
export type ImageLayer = ImageTextLayer | ImageImageLayer | ImageShapeLayer | ImageLogoLayer

/** Define image background styles as color, gradient, or image with optional overlay settings */
export type ImageBackground =
  | { type: 'color'; value: string }
  | { type: 'gradient'; from: string; to: string; direction?: string }
  | { type: 'image'; url: string; overlay?: string; overlayOpacity?: number }

/** Define the structure for an image slide with a background and multiple layers */
export interface ImageSlide {
  background: ImageBackground
  layers: ImageLayer[]
}

/** Define the structure for image content containing an array of image slides */
export interface ImageContent {
  slides: ImageSlide[]
}

// --- Video ---

/** Define properties for a video scene displaying animated text with optional background and effects */
export interface VideoTextAnimationScene {
  type: 'text-animation'
  durationSeconds: number
  headline: string
  subtext?: string
  animation?: 'fade' | 'slide-up' | 'typewriter'
  background?: ImageBackground
}

/** Define a scene that reveals an image with optional caption over a specified duration */
export interface VideoImageRevealScene {
  type: 'image-reveal'
  durationSeconds: number
  imageUrl: string
  caption?: string
}

/** Define a video slide scene with duration and associated image slide details */
export interface VideoSlideScene {
  type: 'slide'
  durationSeconds: number
  slide: ImageSlide
}

/** Define a countdown scene with duration, start time, and optional label for video sequences */
export interface VideoCountdownScene {
  type: 'countdown'
  durationSeconds: number
  from: number
  label?: string
}

/** Resolve a video scene as one of several specific animation or reveal types */
export type VideoScene =
  | VideoTextAnimationScene
  | VideoImageRevealScene
  | VideoSlideScene
  | VideoCountdownScene

/** Define video caption segments with start and end times and associated text content */
export interface VideoCaption {
  startSeconds: number
  endSeconds: number
  text: string
}

/** Describe video content including duration, scenes, optional audio, captions, and rendered URL */
export interface VideoContent {
  durationSeconds: number
  scenes: VideoScene[]
  audioUrl?: string
  captions?: VideoCaption[]
  renderedUrl?: string
}

// --- Copy ---

/** Define platform options for copy content across various social media and communication channels */
export type CopyPlatform = 'instagram' | 'tiktok' | 'x' | 'linkedin' | 'sms' | 'email-subject'

/** Define the structure for content with headline, body, platform, and optional hashtags and character count */
export interface CopyContent {
  headline: string
  body: string
  hashtags?: string[]
  platform: CopyPlatform
  characterCount?: number
}

// --- Core spec ---

/** Map asset keys to their corresponding content types for various media and copy formats */
export type AssetContentMap = {
  email: EmailContent
  'image:feed': ImageContent
  'image:story': ImageContent
  'image:carousel': ImageContent
  'video:reel': VideoContent
  'video:feed': VideoContent
  'copy:caption': CopyContent
  'copy:headline': CopyContent
  'copy:sms': CopyContent
}

/** Define the structure and metadata for an asset including its format, brand, content, and status */
export interface AssetSpec<F extends AssetFormat = AssetFormat> {
  id: string
  workspaceId: string
  campaignId?: string
  format: F
  brand: BrandTokens
  content: AssetContentMap[F]
  status: AssetStatus
  scheduledAt?: string
  createdAt: string
  updatedAt: string
}

// --- Variants & approval ---

/** Describe an asset variant with identification, approval status, and edit history details */
export interface AssetVariant {
  id: string
  parentId: string
  label: string
  spec: AssetSpec
  approvedAt?: string
  rejectedAt?: string
  editLog: ApprovalEvent[]
}

/** Describe an approval event with action details, user info, and optional edited fields */
export interface ApprovalEvent {
  assetId: string
  variantId?: string
  action: 'approved' | 'rejected' | 'edited' | 'scheduled'
  editedFields?: string[]
  userId: string
  timestamp: string
}

/** Define metrics for tracking impressions, clicks, conversions, and related rates */
export interface ConversionMetrics {
  impressions: number
  clicks: number
  conversions: number
  ctr: number
  cvr: number
}
