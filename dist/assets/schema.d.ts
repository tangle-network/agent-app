import { z } from 'zod';
import type { AssetSpec } from './types';
/** Validate brand token properties including colors, font, logo URL, business name, and voice */
export declare const BrandTokensSchema: z.ZodObject<{
    primaryColor: z.ZodString;
    accentColor: z.ZodString;
    textColor: z.ZodString;
    fontFamily: z.ZodString;
    logoUrl: z.ZodOptional<z.ZodString>;
    businessName: z.ZodString;
    voice: z.ZodString;
}, z.core.$strip>;
/** Validate and parse email content objects with subject, optional preheader, and sections */
export declare const EmailContentSchema: z.ZodObject<{
    subject: z.ZodString;
    preheader: z.ZodOptional<z.ZodString>;
    sections: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"hero">;
        headline: z.ZodString;
        subheadline: z.ZodOptional<z.ZodString>;
        imageUrl: z.ZodOptional<z.ZodString>;
        ctaLabel: z.ZodOptional<z.ZodString>;
        ctaUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"body">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"feature">;
        headline: z.ZodString;
        description: z.ZodString;
        imageUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"testimonial">;
        quote: z.ZodString;
        author: z.ZodString;
        role: z.ZodOptional<z.ZodString>;
        avatarUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"cta">;
        label: z.ZodString;
        url: z.ZodString;
        subtext: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"divider">;
    }, z.core.$strip>], "type">>;
}, z.core.$strip>;
/** Validate image content with an array of one or more slides containing background details */
export declare const ImageContentSchema: z.ZodObject<{
    slides: z.ZodArray<z.ZodObject<{
        background: z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"color">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"gradient">;
            from: z.ZodString;
            to: z.ZodString;
            direction: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            url: z.ZodString;
            overlay: z.ZodOptional<z.ZodString>;
            overlayOpacity: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "type">;
        layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"text">;
            text: z.ZodString;
            fontSize: z.ZodOptional<z.ZodNumber>;
            fontWeight: z.ZodOptional<z.ZodEnum<{
                bold: "bold";
                normal: "normal";
            }>>;
            color: z.ZodOptional<z.ZodString>;
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodOptional<z.ZodNumber>;
            align: z.ZodOptional<z.ZodEnum<{
                center: "center";
                left: "left";
                right: "right";
            }>>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            url: z.ZodString;
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
            opacity: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"shape">;
            shape: z.ZodEnum<{
                circle: "circle";
                rect: "rect";
                "rounded-rect": "rounded-rect";
            }>;
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodNumber;
            height: z.ZodNumber;
            fill: z.ZodOptional<z.ZodString>;
            opacity: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"logo">;
            x: z.ZodNumber;
            y: z.ZodNumber;
            width: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "type">>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Define the schema for validating video content including duration, scenes, audio, captions, and rendered URL */
export declare const VideoContentSchema: z.ZodObject<{
    durationSeconds: z.ZodNumber;
    scenes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text-animation">;
        durationSeconds: z.ZodNumber;
        headline: z.ZodString;
        subtext: z.ZodOptional<z.ZodString>;
        animation: z.ZodOptional<z.ZodEnum<{
            fade: "fade";
            "slide-up": "slide-up";
            typewriter: "typewriter";
        }>>;
        background: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"color">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"gradient">;
            from: z.ZodString;
            to: z.ZodString;
            direction: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            url: z.ZodString;
            overlay: z.ZodOptional<z.ZodString>;
            overlayOpacity: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "type">>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image-reveal">;
        durationSeconds: z.ZodNumber;
        imageUrl: z.ZodString;
        caption: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"slide">;
        durationSeconds: z.ZodNumber;
        slide: z.ZodObject<{
            background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"color">;
                value: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"gradient">;
                from: z.ZodString;
                to: z.ZodString;
                direction: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                url: z.ZodString;
                overlay: z.ZodOptional<z.ZodString>;
                overlayOpacity: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>], "type">;
            layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text">;
                text: z.ZodString;
                fontSize: z.ZodOptional<z.ZodNumber>;
                fontWeight: z.ZodOptional<z.ZodEnum<{
                    bold: "bold";
                    normal: "normal";
                }>>;
                color: z.ZodOptional<z.ZodString>;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodOptional<z.ZodNumber>;
                align: z.ZodOptional<z.ZodEnum<{
                    center: "center";
                    left: "left";
                    right: "right";
                }>>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image">;
                url: z.ZodString;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
                opacity: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"shape">;
                shape: z.ZodEnum<{
                    circle: "circle";
                    rect: "rect";
                    "rounded-rect": "rounded-rect";
                }>;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodNumber;
                height: z.ZodNumber;
                fill: z.ZodOptional<z.ZodString>;
                opacity: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"logo">;
                x: z.ZodNumber;
                y: z.ZodNumber;
                width: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>], "type">>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"countdown">;
        durationSeconds: z.ZodNumber;
        from: z.ZodNumber;
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "type">>;
    audioUrl: z.ZodOptional<z.ZodString>;
    captions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        startSeconds: z.ZodNumber;
        endSeconds: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strip>>>;
    renderedUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Validate and parse copy content with headline, body, optional hashtags, platform, and character count */
export declare const CopyContentSchema: z.ZodObject<{
    headline: z.ZodString;
    body: z.ZodString;
    hashtags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    platform: z.ZodEnum<{
        "email-subject": "email-subject";
        instagram: "instagram";
        linkedin: "linkedin";
        sms: "sms";
        tiktok: "tiktok";
        x: "x";
    }>;
    characterCount: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** Validate approval event data including asset, action, user, timestamp, and optional fields */
export declare const ApprovalEventSchema: z.ZodObject<{
    assetId: z.ZodString;
    variantId: z.ZodOptional<z.ZodString>;
    action: z.ZodEnum<{
        approved: "approved";
        edited: "edited";
        rejected: "rejected";
        scheduled: "scheduled";
    }>;
    editedFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
    userId: z.ZodString;
    timestamp: z.ZodString;
}, z.core.$strip>;
/** Validate conversion metrics with nonnegative impressions, clicks, conversions, CTR, and CVR fields */
export declare const ConversionMetricsSchema: z.ZodObject<{
    impressions: z.ZodNumber;
    clicks: z.ZodNumber;
    conversions: z.ZodNumber;
    ctr: z.ZodNumber;
    cvr: z.ZodNumber;
}, z.core.$strip>;
/**
 * JSON Schema for the model-facing asset-create payload.
 *
 * `format`, `brand`, and `content` are required. `campaignId` is optional.
 * The host assigns `id`, `workspaceId`, `status`, and timestamps before it
 * calls {@link parseAssetSpec}; every content branch comes from its parser
 * schema, so this is the one reference products should mount in prompts.
 */
export declare const assetCreateJsonSchema: {
    readonly $schema?: "https://json-schema.org/draft/2020-12/schema" | "http://json-schema.org/draft-07/schema#" | "http://json-schema.org/draft-04/schema#";
    readonly $anchor?: string;
    readonly $ref?: string;
    readonly $dynamicRef?: string;
    readonly $dynamicAnchor?: string;
    readonly $vocabulary?: Record<string, boolean>;
    readonly $comment?: string;
    readonly $defs?: Record<string, z.core.JSONSchema.JSONSchema>;
    readonly type?: "object" | "array" | "string" | "number" | "boolean" | "null" | "integer";
    readonly additionalItems?: z.core.JSONSchema._JSONSchema;
    readonly unevaluatedItems?: z.core.JSONSchema._JSONSchema;
    readonly prefixItems?: z.core.JSONSchema._JSONSchema[];
    readonly items?: z.core.JSONSchema._JSONSchema | z.core.JSONSchema._JSONSchema[];
    readonly contains?: z.core.JSONSchema._JSONSchema;
    readonly additionalProperties?: z.core.JSONSchema._JSONSchema;
    readonly unevaluatedProperties?: z.core.JSONSchema._JSONSchema;
    readonly properties?: Record<string, z.core.JSONSchema._JSONSchema>;
    readonly patternProperties?: Record<string, z.core.JSONSchema._JSONSchema>;
    readonly dependentSchemas?: Record<string, z.core.JSONSchema._JSONSchema>;
    readonly propertyNames?: z.core.JSONSchema._JSONSchema;
    readonly if?: z.core.JSONSchema._JSONSchema;
    readonly then?: z.core.JSONSchema._JSONSchema;
    readonly else?: z.core.JSONSchema._JSONSchema;
    readonly allOf?: z.core.JSONSchema.JSONSchema[];
    readonly anyOf?: z.core.JSONSchema.JSONSchema[];
    readonly oneOf?: z.core.JSONSchema.JSONSchema[];
    readonly not?: z.core.JSONSchema._JSONSchema;
    readonly multipleOf?: number;
    readonly maximum?: number;
    readonly exclusiveMaximum?: number | boolean;
    readonly minimum?: number;
    readonly exclusiveMinimum?: number | boolean;
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly pattern?: string;
    readonly maxItems?: number;
    readonly minItems?: number;
    readonly uniqueItems?: boolean;
    readonly maxContains?: number;
    readonly minContains?: number;
    readonly maxProperties?: number;
    readonly minProperties?: number;
    readonly required?: string[];
    readonly dependentRequired?: Record<string, string[]>;
    readonly enum?: Array<string | number | boolean | null>;
    readonly const?: string | number | boolean | null;
    readonly id?: string;
    readonly default?: unknown;
    readonly deprecated?: boolean;
    readonly readOnly?: boolean;
    readonly writeOnly?: boolean;
    readonly nullable?: boolean;
    readonly examples?: unknown[];
    readonly format?: string;
    readonly contentMediaType?: string;
    readonly contentEncoding?: string;
    readonly contentSchema?: z.core.JSONSchema.JSONSchema;
    readonly _prefault?: unknown;
    readonly "~standard": z.core.ZodStandardSchemaWithJSON<z.ZodUnion<readonly [z.ZodObject<{
        format: z.ZodLiteral<"email">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            subject: z.ZodString;
            preheader: z.ZodOptional<z.ZodString>;
            sections: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"hero">;
                headline: z.ZodString;
                subheadline: z.ZodOptional<z.ZodString>;
                imageUrl: z.ZodOptional<z.ZodString>;
                ctaLabel: z.ZodOptional<z.ZodString>;
                ctaUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"body">;
                text: z.ZodString;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"feature">;
                headline: z.ZodString;
                description: z.ZodString;
                imageUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"testimonial">;
                quote: z.ZodString;
                author: z.ZodString;
                role: z.ZodOptional<z.ZodString>;
                avatarUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"cta">;
                label: z.ZodString;
                url: z.ZodString;
                subtext: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"divider">;
            }, z.core.$strip>], "type">>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"image:feed">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            slides: z.ZodArray<z.ZodObject<{
                background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"color">;
                    value: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"gradient">;
                    from: z.ZodString;
                    to: z.ZodString;
                    direction: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    overlay: z.ZodOptional<z.ZodString>;
                    overlayOpacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">;
                layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    fontSize: z.ZodOptional<z.ZodNumber>;
                    fontWeight: z.ZodOptional<z.ZodEnum<{
                        bold: "bold";
                        normal: "normal";
                    }>>;
                    color: z.ZodOptional<z.ZodString>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                    align: z.ZodOptional<z.ZodEnum<{
                        center: "center";
                        left: "left";
                        right: "right";
                    }>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shape">;
                    shape: z.ZodEnum<{
                        circle: "circle";
                        rect: "rect";
                        "rounded-rect": "rounded-rect";
                    }>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    fill: z.ZodOptional<z.ZodString>;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"logo">;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"image:story">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            slides: z.ZodArray<z.ZodObject<{
                background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"color">;
                    value: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"gradient">;
                    from: z.ZodString;
                    to: z.ZodString;
                    direction: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    overlay: z.ZodOptional<z.ZodString>;
                    overlayOpacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">;
                layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    fontSize: z.ZodOptional<z.ZodNumber>;
                    fontWeight: z.ZodOptional<z.ZodEnum<{
                        bold: "bold";
                        normal: "normal";
                    }>>;
                    color: z.ZodOptional<z.ZodString>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                    align: z.ZodOptional<z.ZodEnum<{
                        center: "center";
                        left: "left";
                        right: "right";
                    }>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shape">;
                    shape: z.ZodEnum<{
                        circle: "circle";
                        rect: "rect";
                        "rounded-rect": "rounded-rect";
                    }>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    fill: z.ZodOptional<z.ZodString>;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"logo">;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"image:carousel">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            slides: z.ZodArray<z.ZodObject<{
                background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"color">;
                    value: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"gradient">;
                    from: z.ZodString;
                    to: z.ZodString;
                    direction: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    overlay: z.ZodOptional<z.ZodString>;
                    overlayOpacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">;
                layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"text">;
                    text: z.ZodString;
                    fontSize: z.ZodOptional<z.ZodNumber>;
                    fontWeight: z.ZodOptional<z.ZodEnum<{
                        bold: "bold";
                        normal: "normal";
                    }>>;
                    color: z.ZodOptional<z.ZodString>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                    align: z.ZodOptional<z.ZodEnum<{
                        center: "center";
                        left: "left";
                        right: "right";
                    }>>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"shape">;
                    shape: z.ZodEnum<{
                        circle: "circle";
                        rect: "rect";
                        "rounded-rect": "rounded-rect";
                    }>;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodNumber;
                    height: z.ZodNumber;
                    fill: z.ZodOptional<z.ZodString>;
                    opacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"logo">;
                    x: z.ZodNumber;
                    y: z.ZodNumber;
                    width: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"video:reel">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            durationSeconds: z.ZodNumber;
            scenes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text-animation">;
                durationSeconds: z.ZodNumber;
                headline: z.ZodString;
                subtext: z.ZodOptional<z.ZodString>;
                animation: z.ZodOptional<z.ZodEnum<{
                    fade: "fade";
                    "slide-up": "slide-up";
                    typewriter: "typewriter";
                }>>;
                background: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"color">;
                    value: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"gradient">;
                    from: z.ZodString;
                    to: z.ZodString;
                    direction: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    overlay: z.ZodOptional<z.ZodString>;
                    overlayOpacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image-reveal">;
                durationSeconds: z.ZodNumber;
                imageUrl: z.ZodString;
                caption: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"slide">;
                durationSeconds: z.ZodNumber;
                slide: z.ZodObject<{
                    background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"color">;
                        value: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"gradient">;
                        from: z.ZodString;
                        to: z.ZodString;
                        direction: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"image">;
                        url: z.ZodString;
                        overlay: z.ZodOptional<z.ZodString>;
                        overlayOpacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>], "type">;
                    layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"text">;
                        text: z.ZodString;
                        fontSize: z.ZodOptional<z.ZodNumber>;
                        fontWeight: z.ZodOptional<z.ZodEnum<{
                            bold: "bold";
                            normal: "normal";
                        }>>;
                        color: z.ZodOptional<z.ZodString>;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodOptional<z.ZodNumber>;
                        align: z.ZodOptional<z.ZodEnum<{
                            center: "center";
                            left: "left";
                            right: "right";
                        }>>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"image">;
                        url: z.ZodString;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodNumber;
                        height: z.ZodNumber;
                        opacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"shape">;
                        shape: z.ZodEnum<{
                            circle: "circle";
                            rect: "rect";
                            "rounded-rect": "rounded-rect";
                        }>;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodNumber;
                        height: z.ZodNumber;
                        fill: z.ZodOptional<z.ZodString>;
                        opacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"logo">;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>], "type">>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"countdown">;
                durationSeconds: z.ZodNumber;
                from: z.ZodNumber;
                label: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>], "type">>;
            audioUrl: z.ZodOptional<z.ZodString>;
            captions: z.ZodOptional<z.ZodArray<z.ZodObject<{
                startSeconds: z.ZodNumber;
                endSeconds: z.ZodNumber;
                text: z.ZodString;
            }, z.core.$strip>>>;
            renderedUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"video:feed">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            durationSeconds: z.ZodNumber;
            scenes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                type: z.ZodLiteral<"text-animation">;
                durationSeconds: z.ZodNumber;
                headline: z.ZodString;
                subtext: z.ZodOptional<z.ZodString>;
                animation: z.ZodOptional<z.ZodEnum<{
                    fade: "fade";
                    "slide-up": "slide-up";
                    typewriter: "typewriter";
                }>>;
                background: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    type: z.ZodLiteral<"color">;
                    value: z.ZodString;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"gradient">;
                    from: z.ZodString;
                    to: z.ZodString;
                    direction: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>, z.ZodObject<{
                    type: z.ZodLiteral<"image">;
                    url: z.ZodString;
                    overlay: z.ZodOptional<z.ZodString>;
                    overlayOpacity: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strip>], "type">>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"image-reveal">;
                durationSeconds: z.ZodNumber;
                imageUrl: z.ZodString;
                caption: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"slide">;
                durationSeconds: z.ZodNumber;
                slide: z.ZodObject<{
                    background: z.ZodDiscriminatedUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"color">;
                        value: z.ZodString;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"gradient">;
                        from: z.ZodString;
                        to: z.ZodString;
                        direction: z.ZodOptional<z.ZodString>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"image">;
                        url: z.ZodString;
                        overlay: z.ZodOptional<z.ZodString>;
                        overlayOpacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>], "type">;
                    layers: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                        type: z.ZodLiteral<"text">;
                        text: z.ZodString;
                        fontSize: z.ZodOptional<z.ZodNumber>;
                        fontWeight: z.ZodOptional<z.ZodEnum<{
                            bold: "bold";
                            normal: "normal";
                        }>>;
                        color: z.ZodOptional<z.ZodString>;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodOptional<z.ZodNumber>;
                        align: z.ZodOptional<z.ZodEnum<{
                            center: "center";
                            left: "left";
                            right: "right";
                        }>>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"image">;
                        url: z.ZodString;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodNumber;
                        height: z.ZodNumber;
                        opacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"shape">;
                        shape: z.ZodEnum<{
                            circle: "circle";
                            rect: "rect";
                            "rounded-rect": "rounded-rect";
                        }>;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodNumber;
                        height: z.ZodNumber;
                        fill: z.ZodOptional<z.ZodString>;
                        opacity: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>, z.ZodObject<{
                        type: z.ZodLiteral<"logo">;
                        x: z.ZodNumber;
                        y: z.ZodNumber;
                        width: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strip>], "type">>;
                }, z.core.$strip>;
            }, z.core.$strip>, z.ZodObject<{
                type: z.ZodLiteral<"countdown">;
                durationSeconds: z.ZodNumber;
                from: z.ZodNumber;
                label: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>], "type">>;
            audioUrl: z.ZodOptional<z.ZodString>;
            captions: z.ZodOptional<z.ZodArray<z.ZodObject<{
                startSeconds: z.ZodNumber;
                endSeconds: z.ZodNumber;
                text: z.ZodString;
            }, z.core.$strip>>>;
            renderedUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"copy:caption">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            headline: z.ZodString;
            body: z.ZodString;
            hashtags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            platform: z.ZodEnum<{
                "email-subject": "email-subject";
                instagram: "instagram";
                linkedin: "linkedin";
                sms: "sms";
                tiktok: "tiktok";
                x: "x";
            }>;
            characterCount: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"copy:headline">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            headline: z.ZodString;
            body: z.ZodString;
            hashtags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            platform: z.ZodEnum<{
                "email-subject": "email-subject";
                instagram: "instagram";
                linkedin: "linkedin";
                sms: "sms";
                tiktok: "tiktok";
                x: "x";
            }>;
            characterCount: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        format: z.ZodLiteral<"copy:sms">;
        campaignId: z.ZodOptional<z.ZodString>;
        brand: z.ZodObject<{
            primaryColor: z.ZodString;
            accentColor: z.ZodString;
            textColor: z.ZodString;
            fontFamily: z.ZodString;
            logoUrl: z.ZodOptional<z.ZodString>;
            businessName: z.ZodString;
            voice: z.ZodString;
        }, z.core.$strip>;
        content: z.ZodObject<{
            headline: z.ZodString;
            body: z.ZodString;
            hashtags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            platform: z.ZodEnum<{
                "email-subject": "email-subject";
                instagram: "instagram";
                linkedin: "linkedin";
                sms: "sms";
                tiktok: "tiktok";
                x: "x";
            }>;
            characterCount: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
    }, z.core.$strip>]>>;
    readonly $id: 'https://tangle.tools/schemas/asset-create.json';
    readonly title: 'AssetCreate';
    readonly description: 'A model-produced marketing asset payload before host metadata is assigned.';
};
/**
 * Validates an unknown value as an AssetSpec, including format-specific
 * content validation. Throws ZodError on invalid input.
 */
export declare function parseAssetSpec(raw: unknown): AssetSpec;
/**
 * Safe parse — returns null instead of throwing.
 */
export declare function safeParseAssetSpec(raw: unknown): AssetSpec | null;
