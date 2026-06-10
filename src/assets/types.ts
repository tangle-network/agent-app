export interface BrandTokens {
  primaryColor: string
  accentColor: string
  textColor: string
  fontFamily: string
  logoUrl?: string
  businessName: string
  voice: string
}

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

export type AssetStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'scheduled'
  | 'published'

// --- Email ---

export interface EmailHeroSection {
  type: 'hero'
  headline: string
  subheadline?: string
  imageUrl?: string
  ctaLabel?: string
  ctaUrl?: string
}

export interface EmailBodySection {
  type: 'body'
  text: string
}

export interface EmailFeatureSection {
  type: 'feature'
  headline: string
  description: string
  imageUrl?: string
}

export interface EmailTestimonialSection {
  type: 'testimonial'
  quote: string
  author: string
  role?: string
  avatarUrl?: string
}

export interface EmailCtaSection {
  type: 'cta'
  label: string
  url: string
  subtext?: string
}

export interface EmailDividerSection {
  type: 'divider'
}

export type EmailSection =
  | EmailHeroSection
  | EmailBodySection
  | EmailFeatureSection
  | EmailTestimonialSection
  | EmailCtaSection
  | EmailDividerSection

export interface EmailContent {
  subject: string
  preheader?: string
  sections: EmailSection[]
}

// --- Image ---

export type ImageLayerType = 'text' | 'image' | 'shape' | 'logo'

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

export interface ImageImageLayer {
  type: 'image'
  url: string
  x: number
  y: number
  width: number
  height: number
  opacity?: number
}

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

export interface ImageLogoLayer {
  type: 'logo'
  x: number
  y: number
  width?: number
}

export type ImageLayer = ImageTextLayer | ImageImageLayer | ImageShapeLayer | ImageLogoLayer

export type ImageBackground =
  | { type: 'color'; value: string }
  | { type: 'gradient'; from: string; to: string; direction?: string }
  | { type: 'image'; url: string; overlay?: string; overlayOpacity?: number }

export interface ImageSlide {
  background: ImageBackground
  layers: ImageLayer[]
}

export interface ImageContent {
  slides: ImageSlide[]
}

// --- Video ---

export interface VideoTextAnimationScene {
  type: 'text-animation'
  durationSeconds: number
  headline: string
  subtext?: string
  animation?: 'fade' | 'slide-up' | 'typewriter'
  background?: ImageBackground
}

export interface VideoImageRevealScene {
  type: 'image-reveal'
  durationSeconds: number
  imageUrl: string
  caption?: string
}

export interface VideoSlideScene {
  type: 'slide'
  durationSeconds: number
  slide: ImageSlide
}

export interface VideoCountdownScene {
  type: 'countdown'
  durationSeconds: number
  from: number
  label?: string
}

export type VideoScene =
  | VideoTextAnimationScene
  | VideoImageRevealScene
  | VideoSlideScene
  | VideoCountdownScene

export interface VideoCaption {
  startSeconds: number
  endSeconds: number
  text: string
}

export interface VideoContent {
  durationSeconds: number
  scenes: VideoScene[]
  audioUrl?: string
  captions?: VideoCaption[]
  renderedUrl?: string
}

// --- Copy ---

export type CopyPlatform = 'instagram' | 'tiktok' | 'x' | 'linkedin' | 'sms' | 'email-subject'

export interface CopyContent {
  headline: string
  body: string
  hashtags?: string[]
  platform: CopyPlatform
  characterCount?: number
}

// --- Core spec ---

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

export interface AssetVariant {
  id: string
  parentId: string
  label: string
  spec: AssetSpec
  approvedAt?: string
  rejectedAt?: string
  editLog: ApprovalEvent[]
}

export interface ApprovalEvent {
  assetId: string
  variantId?: string
  action: 'approved' | 'rejected' | 'edited' | 'scheduled'
  editedFields?: string[]
  userId: string
  timestamp: string
}

export interface ConversionMetrics {
  impressions: number
  clicks: number
  conversions: number
  ctr: number
  cvr: number
}
