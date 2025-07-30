/*
 * glitchGL – Universal WebGL Glitch Effects
 * -----------------------------------------------------------------------------
 *
 * Author: NaughtyDuk© – https://glitchgl.naughtyduk.com
 * Licence: Dual License
 */

(function () {
  "use strict";

  /* --------------------------------------------------
   *  Global State Management
   * ------------------------------------------------*/
  let globalRenderer = null;
  let instanceCounter = 0;
  let activeInstances = new Map();
  let animationFrameId = null;
  let isAnimating = false;
  let resizeObserver = null;
  let resizeDebounceTimer = null;

  /* --------------------------------------------------
   *  Shader Programs for Effects
   * ------------------------------------------------*/
  const shaders = {
    vertex: `
      precision highp float;
      uniform vec2 resolution;
      uniform float textureAspect;
      uniform bool aspectCorrectionEnabled;
      varying vec2 vUv;
      
      void main() {
        vec2 newUv = uv;
        if (aspectCorrectionEnabled && resolution.y > 0.0 && textureAspect > 0.0) {
            float containerAspect = resolution.x / resolution.y;
            if (containerAspect < textureAspect) {
                newUv.x = (uv.x - 0.5) * (containerAspect / textureAspect) + 0.5;
            } else {
                newUv.y = (uv.y - 0.5) * (textureAspect / containerAspect) + 0.5;
            }
        }
        vUv = newUv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    base: `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 vUv;
      
      void main() {
        gl_FragColor = texture2D(u_texture, vUv);
      }
    `,

    // ===== PIXELATION =====
    pixelation: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform highp vec2 resolution;
      uniform float pixelSize;
      uniform float intensity;
      uniform float time;
      
      uniform int pixelShape;
      uniform int bitDepth;
      uniform int dithering;
      uniform int pixelDirection;
      uniform bool interactionEnabled;
      uniform bool pixelationEnabled;
      uniform int isText;
      
      uniform bool pixelSizeInteractive;
      
      uniform int interactionShape;
      uniform sampler2D interactionTexture;
      uniform sampler2D interactionGradientTexture;
      uniform bool hasCustomInteractionTexture;
      
      uniform vec2 mousePx;
      uniform float radiusPx;
      uniform float aspect;
      uniform float pixelRatio;
      uniform float interactionTextureAspect;
      uniform float effectScale;
      
      varying vec2 vUv;
      
      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }
      
      float getInteractionEffect(vec2 fragCoord, vec2 mousePositionPx, float radius) {
        vec2 logicalFragCoord = fragCoord / pixelRatio;
        vec2 offset = logicalFragCoord - mousePositionPx;
        float dist = length(offset);
        
        float scaledRadius = radius * effectScale;
        if (scaledRadius <= 0.0) return 0.0;

        if (interactionShape == 1) {
          float maxDist = max(abs(offset.x), abs(offset.y));
          return 1.0 - smoothstep(0.0, scaledRadius, maxDist);
        } else if (interactionShape == 2) {
          float diamondDist = abs(offset.x) + abs(offset.y);
          return 1.0 - smoothstep(0.0, scaledRadius, diamondDist);
        } else if (interactionShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float crossRadius = scaledRadius * 0.15;
          float crossFalloff = scaledRadius;
          float horizontal = smoothstep(crossRadius, 0.0, abs(rotated.y));
          float vertical = smoothstep(crossRadius, 0.0, abs(rotated.x));
          float crossDistance = max(abs(rotated.x), abs(rotated.y));
          float falloff = smoothstep(crossFalloff, crossFalloff * 0.8, crossDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 4) {
          float plusRadius = scaledRadius * 0.15;
          float plusFalloff = scaledRadius;
          float horizontal = smoothstep(plusRadius, 0.0, abs(offset.y));
          float vertical = smoothstep(plusRadius, 0.0, abs(offset.x));
          float plusDistance = max(abs(offset.x), abs(offset.y));
          float falloff = smoothstep(plusFalloff, plusFalloff * 0.8, plusDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 5) {
          if (hasCustomInteractionTexture) {
            float paddingCompensation = 1.0 / 0.7;
            vec2 scale = vec2(scaledRadius * 2.0 * paddingCompensation);
            vec2 textureUV = offset / scale + 0.5;
            
            float gradient = 0.0;
            if (textureUV.x >= 0.0 && textureUV.x <= 1.0 && textureUV.y >= 0.0 && textureUV.y <= 1.0) {
              gradient = texture2D(interactionGradientTexture, textureUV).r;
            }
            
            return gradient;
          }
          return 0.0;
        } else {
          return 1.0 - smoothstep(0.0, scaledRadius, dist);
        }
      }
      
      vec3 applyBitDepth(vec3 color) {
        if (bitDepth == 1) {
          float gray = dot(color, vec3(0.299, 0.587, 0.114));
          return vec3(step(0.5, gray));
        } else if (bitDepth == 2) {
          return floor(color * 15.0) / 15.0;
        } else if (bitDepth == 3) {
          return floor(color * 255.0) / 255.0;
        }
        return color;
      }
      
      vec3 applyDithering(vec3 color, vec2 screenPos) {
        if (dithering == 1) {
          vec3 quantized = floor(color * 8.0) / 8.0;
          vec3 error = color - quantized;
          float threshold = random(screenPos) * 0.5;
          return quantized + step(threshold, length(error)) * (error * 0.5);
        } else if (dithering == 2) {
          mat4 bayerMatrix = mat4(
            0.0, 8.0, 2.0, 10.0,
            12.0, 4.0, 14.0, 6.0,
            3.0, 11.0, 1.0, 9.0,
            15.0, 7.0, 13.0, 5.0
          );
          
          int x = int(mod(screenPos.x, 4.0));
          int y = int(mod(screenPos.y, 4.0));
          float threshold = bayerMatrix[y][x] / 16.0;
          
          return floor(color + threshold) / 16.0 * 16.0;
        }
        return color;
      }
      
      float getPixelShapeMask(vec2 pixelUV) {
        vec2 center = vec2(0.5);
        vec2 offset = pixelUV - center;
        
        if (pixelShape == 1) {
          return 1.0 - smoothstep(0.3, 0.5, length(offset));
        } else if (pixelShape == 2) {
          return 1.0 - smoothstep(0.3, 0.5, abs(offset.x) + abs(offset.y));
        } else if (pixelShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float horizontal = 1.0 - smoothstep(0.05, 0.15, abs(rotated.y));
          float vertical = 1.0 - smoothstep(0.05, 0.15, abs(rotated.x));
          return max(horizontal, vertical);
        } else if (pixelShape == 4) {
          float horizontal = 1.0 - smoothstep(0.05, 0.15, abs(offset.y));
          float vertical = 1.0 - smoothstep(0.05, 0.15, abs(offset.x));
          return max(horizontal, vertical);
        }
        return 1.0;
      }
      
      void main() {
        vec2 uv = vUv;
        
        vec4 originalSample = texture2D(u_texture, vUv);
        if (!pixelationEnabled) {
          gl_FragColor = originalSample;
          return;
        }
        
        float effectivePixelSize = pixelSize;
        
        if (interactionEnabled) {
          float mouseEffect = getInteractionEffect(gl_FragCoord.xy, mousePx, radiusPx);
          float interactionMultiplier = 1.0 + (mouseEffect * intensity);
          
          if (pixelSizeInteractive) {
            effectivePixelSize = max(1.0, pixelSize * (1.0 - mouseEffect * intensity * 0.9));
          }
        }
        
        vec2 referenceRes = vec2(1920.0, 1080.0);
        float scaleFactor = min(resolution.x / referenceRes.x, resolution.y / referenceRes.y);
        float normalizedPixelSize = effectivePixelSize * scaleFactor;
        
        vec2 pixelCount;
        if (pixelDirection == 1) {
          pixelCount = vec2(resolution.x / normalizedPixelSize, resolution.y / (normalizedPixelSize * 0.3));
        } else if (pixelDirection == 2) {
          pixelCount = vec2(resolution.x / (normalizedPixelSize * 0.3), resolution.y / normalizedPixelSize);
        } else if (pixelDirection == 3) {
          float diagSize = normalizedPixelSize * 0.707;
          pixelCount = resolution / diagSize;
          vec2 center = vec2(0.5);
          vec2 rotated = uv - center;
          rotated = vec2(rotated.x * 0.707 - rotated.y * 0.707, rotated.x * 0.707 + rotated.y * 0.707);
          uv = rotated + center;
        } else {
          pixelCount = resolution / normalizedPixelSize;
        }
        
        vec2 uv_for_shaping = uv;
        vec2 pixelated_uv = floor(uv_for_shaping * pixelCount) / pixelCount;
        
        vec4 pixelatedSample = texture2D(u_texture, pixelated_uv);
        vec3 color = pixelatedSample.rgb;
        float alpha = pixelatedSample.a;
        
        if (pixelShape != 0 && alpha > 0.0) {
          vec2 pixelUV = fract(uv_for_shaping * pixelCount);
          float shapeMask = getPixelShapeMask(pixelUV);
          
          if (isText == 1) {
            alpha *= shapeMask;
          } else {
            vec3 originalColor = texture2D(u_texture, vUv).rgb;
            color = mix(originalColor, pixelatedSample.rgb, shapeMask);
          }
        }
        
        color = applyBitDepth(color);
        color = applyDithering(color, gl_FragCoord.xy);
        
        gl_FragColor = vec4(color, alpha);
      }
    `,

    // ===== CRT =====
    crt: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform highp vec2 resolution;
      uniform float time;
      uniform float scanlineIntensity;
      uniform float scanlineThickness;
      uniform float scanlineCount;
      uniform float phosphorGlow;
      uniform float curvature;
      uniform float chromaticAberration;
      uniform float brightness;
      uniform bool flicker;
      uniform float flickerIntensity;
      uniform bool lineMovement;
      uniform float lineSpeed;
      uniform int lineDirection;
      uniform float intensity;
      uniform bool interactionEnabled;
      uniform bool crtEnabled;
      
      uniform bool chromaticAberrationInteractive;
      uniform bool scanlinesInteractive;
      uniform bool phosphorGlowInteractive;
      uniform bool curvatureInteractive;
      
      uniform int interactionShape;
      uniform sampler2D interactionTexture;
      uniform sampler2D interactionGradientTexture;
      uniform bool hasCustomInteractionTexture;
      
      uniform vec2 mousePx;
      uniform float radiusPx;
      uniform float aspect;
      uniform float pixelRatio;
      uniform float interactionTextureAspect;
      uniform float effectScale;
      
      uniform bool pixelationEnabled;
      uniform float pixelSize;
      
      varying vec2 vUv;
      
      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }
      
      float getInteractionEffect(vec2 fragCoord, vec2 mousePositionPx, float radius) {
        vec2 logicalFragCoord = fragCoord / pixelRatio;
        vec2 offset = logicalFragCoord - mousePositionPx;
        
        float scaledRadius = radius * effectScale;
        if (scaledRadius <= 0.0) return 0.0;
        
        if (interactionShape == 1) {
          float maxDist = max(abs(offset.x), abs(offset.y));
          return smoothstep(scaledRadius, 0.0, maxDist);
        } else if (interactionShape == 2) {
          float diamondDist = abs(offset.x) + abs(offset.y);
          return smoothstep(scaledRadius, 0.0, diamondDist);
        } else if (interactionShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float crossRadius = scaledRadius * 0.15;
          float crossFalloff = scaledRadius;
          float horizontal = smoothstep(crossRadius, 0.0, abs(rotated.y));
          float vertical = smoothstep(crossRadius, 0.0, abs(rotated.x));
          float crossDistance = max(abs(rotated.x), abs(rotated.y));
          float falloff = smoothstep(crossFalloff, crossFalloff * 0.8, crossDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 4) {
          float plusRadius = scaledRadius * 0.15;
          float plusFalloff = scaledRadius;
          float horizontal = smoothstep(plusRadius, 0.0, abs(offset.y));
          float vertical = smoothstep(plusRadius, 0.0, abs(offset.x));
          float plusDistance = max(abs(offset.x), abs(offset.y));
          float falloff = smoothstep(plusFalloff, plusFalloff * 0.8, plusDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 5) {
          if (hasCustomInteractionTexture) {
            float paddingCompensation = 1.0 / 0.7;
            vec2 scale = vec2(scaledRadius * 2.0 * paddingCompensation);
            vec2 textureUV = offset / scale + 0.5;
            
            float gradient = 0.0;
            if (textureUV.x >= 0.0 && textureUV.x <= 1.0 && textureUV.y >= 0.0 && textureUV.y <= 1.0) {
              gradient = texture2D(interactionGradientTexture, textureUV).r;
            }
            
            return gradient;
          }
          float dist = length(offset);
          return smoothstep(scaledRadius, 0.0, dist);
        } else {
          float dist = length(offset);
          return smoothstep(scaledRadius, 0.0, dist);
        }
      }
      
      vec2 curveRemapUV(vec2 uv) {
        uv = uv * 2.0 - 1.0;
        vec2 offset = abs(uv.yx) * curvature / 20.0;
        uv = uv + uv * offset * offset;
        uv = uv * 0.5 + 0.5;
        return uv;
      }
      
      void main() {
        vec2 uv = vUv;
        
        vec4 originalSample = texture2D(u_texture, vUv);
        if (!crtEnabled) {
          gl_FragColor = originalSample;
          return;
        }
        
        float mouseEffect = 0.0;
        float interactionMultiplier = 1.0;
        if (interactionEnabled) {
          mouseEffect = getInteractionEffect(gl_FragCoord.xy, mousePx, radiusPx);
          interactionMultiplier = 1.0 + (mouseEffect * intensity);
        }
        
        float effectiveCurvature = curvature;
        if (curvatureInteractive) {
          effectiveCurvature = curvature * (1.0 + mouseEffect * intensity);
          effectiveCurvature = clamp(effectiveCurvature, 0.0, 25.0);
        }
        
        vec2 curvedUV = uv;
        if (effectiveCurvature > 0.0) {
          curvedUV = uv * 2.0 - 1.0;
          vec2 offset = abs(curvedUV.yx) * effectiveCurvature / 20.0;
          curvedUV = curvedUV + curvedUV * offset * offset;
          curvedUV = curvedUV * 0.5 + 0.5;
        }
        
        float effectiveAberration = chromaticAberration;
        if (chromaticAberrationInteractive) {
          effectiveAberration *= interactionMultiplier;
        }
        vec2 aberrationOffset = (curvedUV - 0.5) * effectiveAberration;
        
        float r = texture2D(u_texture, curvedUV - aberrationOffset).r;
        float g = texture2D(u_texture, curvedUV).g;
        float b = texture2D(u_texture, curvedUV + aberrationOffset).b;
        
        vec3 color = vec3(r, g, b);
        
        float effectiveScanlineCount = scanlineCount > 0.0 ? scanlineCount : resolution.y * 0.5;
        
        vec2 animatedUV = curvedUV;
        if (lineMovement) {
          float movement = time * lineSpeed;
          if (lineDirection == 0) {
            animatedUV.y += movement;
          } else if (lineDirection == 1) {
            animatedUV.y -= movement;
          } else if (lineDirection == 2) {
            animatedUV.x += movement;
          } else if (lineDirection == 3) {
            animatedUV.x -= movement;
          }
        }
        
        float scanlinePos;
        if (lineDirection == 2 || lineDirection == 3) {
          scanlinePos = animatedUV.x * effectiveScanlineCount;
        } else {
          scanlinePos = animatedUV.y * effectiveScanlineCount;
        }
        
        float scanlinePattern = sin(scanlinePos * 3.14159 * 2.0);
        
        float thicknessFactor = mix(0.05, 0.95, scanlineThickness);
        float scanlineMask = smoothstep(-thicknessFactor, thicknessFactor, scanlinePattern);
        
        float effectiveScanlineIntensity = scanlineIntensity;
        if (scanlinesInteractive) {
          effectiveScanlineIntensity *= interactionMultiplier;
        }
        float minIntensity = mix(0.8, 0.1, effectiveScanlineIntensity);
        float scanlineEffect = mix(minIntensity, 1.0, scanlineMask);
        color *= scanlineEffect;
        
        if (flicker) {
          float flickerAmount = sin(time * 60.0) * 0.5 + 0.5;
          flickerAmount = mix(1.0, flickerAmount, flickerIntensity);
          color *= flickerAmount;
        }
        
        float effectivePhosphorGlow = phosphorGlow;
        if (phosphorGlowInteractive) {
          effectivePhosphorGlow *= interactionMultiplier;
        }
        color += color * effectivePhosphorGlow;
        
        color *= brightness;
        
        gl_FragColor = vec4(color, texture2D(u_texture, curvedUV).a);
      }
    `,

    // ===== GLITCH =====
    glitch: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform highp vec2 resolution;
      uniform float time;
      uniform float intensity;
      
      uniform float rgbShift;
      uniform float digitalNoise;
      uniform float lineDisplacement;
      
      uniform float bitCrushDepth;

      uniform float signalDropoutFreq;
      uniform float signalDropoutSize;
      uniform float syncErrorFreq;
      uniform float syncErrorAmount;
      uniform float interferenceSpeed;
      uniform float interferenceIntensity;
      uniform float frameGhostAmount;
      uniform float stutterFreq;
      uniform float datamoshStrength;
      
      uniform bool interactionEnabled;
      uniform bool rgbShiftInteractive;
      uniform bool digitalNoiseInteractive;
      uniform bool lineDisplacementInteractive;
      uniform bool bitCrushInteractive;

      uniform bool signalDropoutInteractive;
      uniform bool syncErrorsInteractive;
      uniform bool interferenceLinesInteractive;
      uniform bool frameGhostingInteractive;
      uniform bool stutterFreezeInteractive;
      uniform bool datamoshingInteractive;
      
      uniform int interactionShape;
      uniform sampler2D interactionTexture;
      uniform sampler2D interactionGradientTexture;
      uniform bool hasCustomInteractionTexture;
      
      uniform vec2 mousePx;
      uniform float radiusPx;
      uniform float aspect;
      uniform float pixelRatio;
      uniform float interactionTextureAspect;
      uniform float effectScale;
      
      varying vec2 vUv;
      
      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }
      
      float random3(vec3 st) {
        return fract(sin(dot(st.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453123);
      }
      
      float getInteractionEffect(vec2 fragCoord, vec2 mousePositionPx, float radius) {
        vec2 logicalFragCoord = fragCoord / pixelRatio;
        vec2 offset = logicalFragCoord - mousePositionPx;
        
        float scaledRadius = radius * effectScale;
        if (scaledRadius <= 0.0) return 0.0;
        
        if (interactionShape == 1) {
          float maxDist = max(abs(offset.x), abs(offset.y));
          return smoothstep(scaledRadius, 0.0, maxDist);
        } else if (interactionShape == 2) {
          float diamondDist = abs(offset.x) + abs(offset.y);
          return smoothstep(scaledRadius, 0.0, diamondDist);
        } else if (interactionShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float crossRadius = scaledRadius * 0.15;
          float crossFalloff = scaledRadius;
          float horizontal = smoothstep(crossRadius, 0.0, abs(rotated.y));
          float vertical = smoothstep(crossRadius, 0.0, abs(rotated.x));
          float crossDistance = max(abs(rotated.x), abs(rotated.y));
          float falloff = smoothstep(crossFalloff, crossFalloff * 0.8, crossDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 4) {
          float plusRadius = scaledRadius * 0.15;
          float plusFalloff = scaledRadius;
          float horizontal = smoothstep(plusRadius, 0.0, abs(offset.y));
          float vertical = smoothstep(plusRadius, 0.0, abs(offset.x));
          float plusDistance = max(abs(offset.x), abs(offset.y));
          float falloff = smoothstep(plusFalloff, plusFalloff * 0.8, plusDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 5) {
          if (hasCustomInteractionTexture) {
            float paddingCompensation = 1.0 / 0.7;
            vec2 scale = vec2(scaledRadius * 2.0 * paddingCompensation);
            vec2 textureUV = offset / scale + 0.5;
            
            float gradient = 0.0;
            if (textureUV.x >= 0.0 && textureUV.x <= 1.0 && textureUV.y >= 0.0 && textureUV.y <= 1.0) {
              gradient = texture2D(interactionGradientTexture, textureUV).r;
            }
            
            return gradient;
          }
          return 0.0;
        } else {
          float dist = length(offset);
          return smoothstep(scaledRadius, 0.0, dist);
        }
      }
      
      void main() {
        vec2 uv = vUv;
        vec3 color = texture2D(u_texture, uv).rgb;
        
        float mouseEffect = 0.0;
        if (interactionEnabled) {
          mouseEffect = getInteractionEffect(gl_FragCoord.xy, mousePx, radiusPx);
        }
        float interactionMultiplier = 1.0 + (mouseEffect * intensity);
        
        if (signalDropoutFreq > 0.0) {
          float effectiveDropout = signalDropoutFreq;
          if (signalDropoutInteractive) effectiveDropout *= interactionMultiplier;
          
          vec2 dropoutSize = vec2(signalDropoutSize * 5.0);
          vec2 dropoutUV = floor(uv / dropoutSize) * dropoutSize;
          float dropoutNoise = random3(vec3(dropoutUV, floor(time * 6.0)));
          
          if (dropoutNoise < effectiveDropout * 3.0) {
            if (dropoutNoise < effectiveDropout * 1.0) {
              color = vec3(0.0);
            } else if (dropoutNoise < effectiveDropout * 2.0) {
              color = vec3(1.0);
            } else {
              color = vec3(1.0, 0.0, 0.0);
            }
          }
        }
        
        if (syncErrorFreq > 0.0) {
          float effectiveSync = syncErrorAmount;
          if (syncErrorsInteractive) effectiveSync *= interactionMultiplier;
          
          float lineNoise = random(vec2(floor(uv.y * 100.0), floor(time * 8.0)));
          if (lineNoise < syncErrorFreq * 10.0) {
            float displacement = (random(vec2(uv.y, time)) - 0.5) * effectiveSync * 20.0;
            vec2 syncUV = vec2(uv.x + displacement, uv.y);
            color = sampleWithEffects(syncUV, mouseEffect, interactionMultiplier).rgb;
          }
        }
        
        if (interferenceIntensity > 0.0) {
          float effectiveInterference = interferenceIntensity;
          if (interferenceLinesInteractive) effectiveInterference *= interactionMultiplier;
          
          float interference = sin((uv.y + time * interferenceSpeed * 2.0) * 100.0);
          color += vec3(interference * effectiveInterference);
        }
        
        if (frameGhostAmount > 0.0) {
          float effectiveGhost = frameGhostAmount;
          if (frameGhostingInteractive) effectiveGhost *= interactionMultiplier;
          
          vec2 ghost1 = uv + vec2(sin(time * 0.5) * 0.02, cos(time * 0.3) * 0.02);
          vec2 ghost2 = uv + vec2(sin(time * 0.7) * 0.03, cos(time * 0.5) * 0.015);
          vec2 ghost3 = uv + vec2(sin(time * 0.9) * 0.025, cos(time * 0.7) * 0.02);
          
          vec3 ghostColor1 = texture2D(u_texture, ghost1).rgb;
          vec3 ghostColor2 = texture2D(u_texture, ghost2).rgb;
          vec3 ghostColor3 = texture2D(u_texture, ghost3).rgb;
          
          vec3 ghostMix = (ghostColor1 + ghostColor2 + ghostColor3) / 3.0;
          color = mix(color, ghostMix, effectiveGhost);
        }
        
        if (stutterFreq > 0.0) {
          float stutterNoise = random(vec2(floor(time * 10.0), floor(uv.y * 50.0)));
          if (stutterNoise < stutterFreq * 5.0) {
            color = color;
          }
        }
        
        if (datamoshStrength > 0.0) {
          float effectiveDatamosh = datamoshStrength;
          if (datamoshingInteractive && mouseEffect > 0.0) {
            effectiveDatamosh *= interactionMultiplier;
            
            vec2 mouseUV = mousePx / resolution;
            vec2 distortion = (uv - mouseUV) * mouseEffect * effectiveDatamosh * 0.3;
            vec2 datamoshUV = uv + vec2(
              sin(distortion.x * 20.0 + time) * 0.02,
              cos(distortion.y * 15.0 + time) * 0.025
            ) * mouseEffect;
            color = sampleWithEffects(datamoshUV, mouseEffect, interactionMultiplier).rgb;
          } else if (!datamoshingInteractive) {
            vec2 globalDistortion = vec2(
              sin(uv.x * 10.0 + time * 2.0) * effectiveDatamosh * 0.01,
              cos(uv.y * 8.0 + time * 1.5) * effectiveDatamosh * 0.012
            );
            color = sampleWithEffects(uv + globalDistortion, mouseEffect, interactionMultiplier).rgb;
          }
        }
        
        float effectiveShift = rgbShift;
        if (rgbShiftInteractive) effectiveShift *= interactionMultiplier;
        
        if (effectiveShift > 0.0) {
          vec3 shiftedColor = color;
          float shiftAmount = effectiveShift * sin(time * 10.0 + uv.y * 50.0) * 50.0;
          shiftedColor.r = mix(color.r, color.g, abs(shiftAmount));
          shiftedColor.b = mix(color.b, color.g, abs(shiftAmount));
          color = mix(color, shiftedColor, clamp(effectiveShift * 20.0, 0.0, 1.0));
        }
        
        if (bitCrushDepth > 0.0) {
          float effectiveDepth = bitCrushDepth;
          if (bitCrushInteractive) effectiveDepth *= interactionMultiplier;
          
          float levels = max(2.0, 32.0 - effectiveDepth * 4.0);
          color = floor(color * levels) / levels;
        }
        
        if (lineDisplacement > 0.0) {
          float effectiveDisplacement = lineDisplacement;
          if (lineDisplacementInteractive) effectiveDisplacement *= interactionMultiplier;
          
          float lineNoise = random(vec2(floor(uv.y * 100.0), floor(time * 8.0)));
          if (lineNoise > 0.95) {
            float displacement = (random(vec2(uv.y, time)) - 0.5) * effectiveDisplacement;
            float distFromCenter = abs(uv.x - 0.5) * 2.0;
            float triangularStrength = 0.2 + distFromCenter * 0.8;
            
            vec3 distortedColor = color;
            distortedColor.r = mix(color.r, color.g, abs(displacement * triangularStrength * 50.0));
            distortedColor.b = mix(color.b, color.r, abs(displacement * triangularStrength * 50.0));
            color = mix(color, distortedColor, clamp(effectiveDisplacement * 10.0, 0.0, 1.0));
          }
        }
        
        if (digitalNoise > 0.0) {
          float effectiveNoise = digitalNoise;
          if (digitalNoiseInteractive) effectiveNoise *= interactionMultiplier;
          
          float noise = random(uv + time);
          if (noise > (1.0 - effectiveNoise * 0.1)) {
            color = mix(color, vec3(noise), effectiveNoise * 0.8);
          }
        }
        

        
        gl_FragColor = vec4(color, 1.0);
      }
    `,

    combined: `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform highp vec2 resolution;
      uniform float time;
      uniform float intensity;
      
      uniform bool pixelationEnabled;
      uniform bool crtEnabled;
      uniform bool glitchEnabled;
      
      // ===== PIXELATION UNIFORMS =====
      uniform float pixelSize;
      uniform int pixelShape;
      uniform int bitDepth;
      uniform int dithering;
      uniform int pixelDirection;
      uniform int isText;
      uniform bool pixelSizeInteractive;
      
      // ===== CRT UNIFORMS =====
      uniform float scanlineIntensity;
      uniform float scanlineThickness;
      uniform float scanlineCount;
      uniform float phosphorGlow;
      uniform float curvature;
      uniform float chromaticAberration;
      uniform float brightness;
      uniform bool flicker;
      uniform float flickerIntensity;
      uniform bool lineMovement;
      uniform float lineSpeed;
      uniform int lineDirection;
      uniform bool chromaticAberrationInteractive;
      uniform bool scanlinesInteractive;
      uniform bool phosphorGlowInteractive;
      uniform bool curvatureInteractive;
      
      // ===== GLITCH UNIFORMS =====
      uniform float rgbShift;
      uniform float digitalNoise;
      uniform float lineDisplacement;
      uniform float bitCrushDepth;
      uniform float signalDropoutFreq;
      uniform float signalDropoutSize;
      uniform float syncErrorFreq;
      uniform float syncErrorAmount;
      uniform float interferenceSpeed;
      uniform float interferenceIntensity;
      uniform float frameGhostAmount;
      uniform float stutterFreq;
      uniform float datamoshStrength;
      uniform bool rgbShiftInteractive;
      uniform bool digitalNoiseInteractive;
      uniform bool lineDisplacementInteractive;
      uniform bool bitCrushInteractive;
      uniform bool signalDropoutInteractive;
      uniform bool syncErrorsInteractive;
      uniform bool interferenceLinesInteractive;
      uniform bool frameGhostingInteractive;
      uniform bool stutterFreezeInteractive;
      uniform bool datamoshingInteractive;
      
      // ===== SHARED INTERACTION UNIFORMS =====
      uniform bool interactionEnabled;
      uniform int interactionShape;
      uniform sampler2D interactionTexture;
      uniform sampler2D interactionGradientTexture;
      uniform bool hasCustomInteractionTexture;
      uniform vec2 mousePx;
      uniform float radiusPx;
      uniform float aspect;
      uniform float pixelRatio;
      uniform float interactionTextureAspect;
      uniform float effectScale;
      
      varying vec2 vUv;
      
      // ===== UTILITY FUNCTIONS =====
      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }
      
      float random3(vec3 st) {
        return fract(sin(dot(st.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453123);
      }
      
      float getInteractionEffect(vec2 fragCoord, vec2 mousePositionPx, float radius) {
        vec2 logicalFragCoord = fragCoord / pixelRatio;
        vec2 offset = logicalFragCoord - mousePositionPx;
        float dist = length(offset);
        
        float scaledRadius = radius * effectScale;
        if (scaledRadius <= 0.0) return 0.0;

        if (interactionShape == 1) {
          float maxDist = max(abs(offset.x), abs(offset.y));
          return 1.0 - smoothstep(0.0, scaledRadius, maxDist);
        } else if (interactionShape == 2) {
          float diamondDist = abs(offset.x) + abs(offset.y);
          return 1.0 - smoothstep(0.0, scaledRadius, diamondDist);
        } else if (interactionShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float crossRadius = scaledRadius * 0.15;
          float crossFalloff = scaledRadius;
          float horizontal = smoothstep(crossRadius, 0.0, abs(rotated.y));
          float vertical = smoothstep(crossRadius, 0.0, abs(rotated.x));
          float crossDistance = max(abs(rotated.x), abs(rotated.y));
          float falloff = smoothstep(crossFalloff, crossFalloff * 0.8, crossDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 4) {
          float plusRadius = scaledRadius * 0.15;
          float plusFalloff = scaledRadius;
          float horizontal = smoothstep(plusRadius, 0.0, abs(offset.y));
          float vertical = smoothstep(plusRadius, 0.0, abs(offset.x));
          float plusDistance = max(abs(offset.x), abs(offset.y));
          float falloff = smoothstep(plusFalloff, plusFalloff * 0.8, plusDistance);
          return max(horizontal, vertical) * falloff;
        } else if (interactionShape == 5) {
          if (hasCustomInteractionTexture) {
            float paddingCompensation = 1.0 / 0.7;
            vec2 scale = vec2(scaledRadius * 2.0 * paddingCompensation);
            vec2 textureUV = offset / scale + 0.5;
            
            float gradient = 0.0;
            if (textureUV.x >= 0.0 && textureUV.x <= 1.0 && textureUV.y >= 0.0 && textureUV.y <= 1.0) {
              gradient = texture2D(interactionGradientTexture, textureUV).r;
            }
            
            return gradient;
          }
          return 0.0;
        } else {
          return 1.0 - smoothstep(0.0, scaledRadius, dist);
        }
      }
      
      // ===== PIXELATION EFFECT FUNCTIONS =====
      vec3 applyBitDepth(vec3 color) {
        if (bitDepth == 1) {
          float gray = dot(color, vec3(0.299, 0.587, 0.114));
          return vec3(step(0.5, gray));
        } else if (bitDepth == 2) {
          return floor(color * 15.0) / 15.0;
        } else if (bitDepth == 3) {
          return floor(color * 255.0) / 255.0;
        }
        return color;
      }
      
      vec3 applyDithering(vec3 color, vec2 screenPos) {
        if (dithering == 1) {
          vec3 quantized = floor(color * 8.0) / 8.0;
          vec3 error = color - quantized;
          float threshold = random(screenPos) * 0.5;
          return quantized + step(threshold, length(error)) * (error * 0.5);
        } else if (dithering == 2) {
          mat4 bayerMatrix = mat4(
            0.0, 8.0, 2.0, 10.0,
            12.0, 4.0, 14.0, 6.0,
            3.0, 11.0, 1.0, 9.0,
            15.0, 7.0, 13.0, 5.0
          );
          
          int x = int(mod(screenPos.x, 4.0));
          int y = int(mod(screenPos.y, 4.0));
          float threshold = bayerMatrix[y][x] / 16.0;
          
          return floor(color + threshold) / 16.0 * 16.0;
        }
        return color;
      }
      
      float getPixelShapeMask(vec2 pixelUV) {
        vec2 center = vec2(0.5);
        vec2 offset = pixelUV - center;
        
        if (pixelShape == 1) {
          return 1.0 - smoothstep(0.3, 0.5, length(offset));
        } else if (pixelShape == 2) {
          return 1.0 - smoothstep(0.3, 0.5, abs(offset.x) + abs(offset.y));
        } else if (pixelShape == 3) {
          float cos45 = 0.707;
          float sin45 = 0.707;
          vec2 rotated = vec2(
            offset.x * cos45 - offset.y * sin45,
            offset.x * sin45 + offset.y * cos45
          );
          float horizontal = 1.0 - smoothstep(0.05, 0.15, abs(rotated.y));
          float vertical = 1.0 - smoothstep(0.05, 0.15, abs(rotated.x));
          return max(horizontal, vertical);
        } else if (pixelShape == 4) {
          float horizontal = 1.0 - smoothstep(0.05, 0.15, abs(offset.y));
          float vertical = 1.0 - smoothstep(0.05, 0.15, abs(offset.x));
          return max(horizontal, vertical);
        }
        return 1.0;
      }
      
      vec4 applyPixelationToUV(vec2 uv, float mouseEffect, float interactionMultiplier) {
        float effectivePixelSize = pixelSize;
        
        if (interactionEnabled) {
          if (pixelSizeInteractive) {
            effectivePixelSize = max(1.0, pixelSize * (1.0 - mouseEffect * intensity * 0.9));
          }
        }
        
        vec2 referenceRes = vec2(1920.0, 1080.0);
        float scaleFactor = min(resolution.x / referenceRes.x, resolution.y / referenceRes.y);
        float normalizedPixelSize = effectivePixelSize * scaleFactor;
        
        vec2 pixelCount;
        vec2 workingUV = uv;
        
        if (pixelDirection == 1) {
          pixelCount = vec2(resolution.x / normalizedPixelSize, resolution.y / (normalizedPixelSize * 0.3));
        } else if (pixelDirection == 2) {
          pixelCount = vec2(resolution.x / (normalizedPixelSize * 0.3), resolution.y / normalizedPixelSize);
        } else if (pixelDirection == 3) {
          float diagSize = normalizedPixelSize * 0.707;
          pixelCount = resolution / diagSize;
          vec2 center = vec2(0.5);
          vec2 rotated = workingUV - center;
          rotated = vec2(rotated.x * 0.707 - rotated.y * 0.707, rotated.x * 0.707 + rotated.y * 0.707);
          workingUV = rotated + center;
        } else {
          pixelCount = resolution / normalizedPixelSize;
        }
        
        vec2 pixelated_uv = floor(workingUV * pixelCount) / pixelCount;
        vec4 pixelatedSample = texture2D(u_texture, pixelated_uv);
        vec3 color = pixelatedSample.rgb;
        float alpha = pixelatedSample.a;
        
        vec4 originalSample = texture2D(u_texture, uv);
        
        if (pixelShape != 0 && alpha > 0.0) {
          vec2 pixelUV = fract(workingUV * pixelCount);
          float shapeMask = getPixelShapeMask(pixelUV);
          
          if (isText == 1) {
            alpha *= shapeMask;
          } else {
            vec3 originalColor = originalSample.rgb;
            color = mix(originalColor, pixelatedSample.rgb, shapeMask);
          }
        }
        
        color = applyBitDepth(color);
        color = applyDithering(color, gl_FragCoord.xy);
        
        return vec4(color, alpha);
      }
      
      vec3 applyCRTColorEffects(vec3 color, vec2 uv, float mouseEffect, float interactionMultiplier) {
        if (!crtEnabled) return color;
        
        if (chromaticAberration > 0.0) {
          float effectiveAberration = chromaticAberration;
          if (chromaticAberrationInteractive) {
            effectiveAberration *= interactionMultiplier;
          }
          
          vec2 aberrationOffset = (uv - 0.5) * effectiveAberration;
          vec3 aberratedColor = color;
          aberratedColor.r *= 1.0 + abs(aberrationOffset.x) * 2.0;
          aberratedColor.b *= 1.0 + abs(aberrationOffset.x) * 2.0;
          color = mix(color, aberratedColor, clamp(effectiveAberration * 10.0, 0.0, 0.5));
        }
        
        float effectiveScanlineCount = scanlineCount > 0.0 ? scanlineCount : resolution.y * 0.5;
        vec2 animatedUV = uv;
        if (lineMovement) {
          float movement = time * lineSpeed;
          if (lineDirection == 0) animatedUV.y += movement;
          else if (lineDirection == 1) animatedUV.y -= movement;
          else if (lineDirection == 2) animatedUV.x += movement;
          else if (lineDirection == 3) animatedUV.x -= movement;
        }
        
        float scanlinePos = (lineDirection == 2 || lineDirection == 3) 
          ? animatedUV.x * effectiveScanlineCount 
          : animatedUV.y * effectiveScanlineCount;
        
        float scanlinePattern = sin(scanlinePos * 3.14159 * 2.0);
        float thicknessFactor = mix(0.05, 0.95, scanlineThickness);
        float scanlineMask = smoothstep(-thicknessFactor, thicknessFactor, scanlinePattern);
        
        float effectiveScanlineIntensity = scanlineIntensity;
        if (scanlinesInteractive) {
          effectiveScanlineIntensity *= interactionMultiplier;
        }
        float minIntensity = mix(0.8, 0.1, effectiveScanlineIntensity);
        float scanlineEffect = mix(minIntensity, 1.0, scanlineMask);
        color *= scanlineEffect;
        
        if (flicker) {
          float flickerAmount = sin(time * 60.0) * 0.5 + 0.5;
          flickerAmount = mix(1.0, flickerAmount, flickerIntensity);
          color *= flickerAmount;
        }
        
        float effectivePhosphorGlow = phosphorGlow;
        if (phosphorGlowInteractive) {
          effectivePhosphorGlow *= interactionMultiplier;
        }
        color += color * effectivePhosphorGlow;
        
        color *= brightness;
        
        return color;
      }
      
      vec4 sampleWithGeometricEffects(vec2 uv, float mouseEffect, float interactionMultiplier) {
        vec2 samplingUV = uv;
        if (crtEnabled && curvature > 0.0) {
          float effectiveCurvature = curvature;
          if (curvatureInteractive) {
            effectiveCurvature = curvature * (1.0 + mouseEffect * intensity);
            effectiveCurvature = clamp(effectiveCurvature, 0.0, 25.0);
          }
          
          vec2 curvedUV = uv * 2.0 - 1.0;
          vec2 offset = abs(curvedUV.yx) * effectiveCurvature / 20.0;
          curvedUV = curvedUV + curvedUV * offset * offset;
          samplingUV = curvedUV * 0.5 + 0.5;
        }
        
        if (pixelationEnabled) {
          vec4 pixelatedResult = applyPixelationToUV(samplingUV, mouseEffect, interactionMultiplier);
          return pixelatedResult;
        }
        
        return texture2D(u_texture, samplingUV);
      }
      
      vec4 sampleWithEffects(vec2 uv, float mouseEffect, float interactionMultiplier) {
        vec4 sampledColor = sampleWithGeometricEffects(uv, mouseEffect, interactionMultiplier);
        
        if (crtEnabled) {
          sampledColor.rgb = applyCRTColorEffects(sampledColor.rgb, uv, mouseEffect, interactionMultiplier);
        }
        
        return sampledColor;
      }
      
      vec4 applyPixelation(vec2 uv, vec4 inputColor, float mouseEffect, float interactionMultiplier) {
        float effectivePixelSize = pixelSize;
        
        if (interactionEnabled) {
          if (pixelSizeInteractive) {
            effectivePixelSize = max(1.0, pixelSize * (1.0 - mouseEffect * intensity * 0.9));
          }
        }
        
        vec2 referenceRes = vec2(1920.0, 1080.0);
        float scaleFactor = min(resolution.x / referenceRes.x, resolution.y / referenceRes.y);
        float normalizedPixelSize = effectivePixelSize * scaleFactor;
        
        vec2 pixelCount;
        vec2 workingUV = uv;
        
        if (pixelDirection == 1) {
          pixelCount = vec2(resolution.x / normalizedPixelSize, resolution.y / (normalizedPixelSize * 0.3));
        } else if (pixelDirection == 2) {
          pixelCount = vec2(resolution.x / (normalizedPixelSize * 0.3), resolution.y / normalizedPixelSize);
        } else if (pixelDirection == 3) {
          float diagSize = normalizedPixelSize * 0.707;
          pixelCount = resolution / diagSize;
          vec2 center = vec2(0.5);
          vec2 rotated = workingUV - center;
          rotated = vec2(rotated.x * 0.707 - rotated.y * 0.707, rotated.x * 0.707 + rotated.y * 0.707);
          workingUV = rotated + center;
        } else {
          pixelCount = resolution / normalizedPixelSize;
        }
        
        vec2 pixelated_uv = floor(workingUV * pixelCount) / pixelCount;
        vec4 pixelatedSample = texture2D(u_texture, pixelated_uv);
        vec3 color = pixelatedSample.rgb;
        float alpha = pixelatedSample.a;
        
        if (pixelShape != 0 && alpha > 0.0) {
          vec2 pixelUV = fract(workingUV * pixelCount);
          float shapeMask = getPixelShapeMask(pixelUV);
          
          if (isText == 1) {
            alpha *= shapeMask;
          } else {
            vec3 originalColor = inputColor.rgb;
            color = mix(originalColor, pixelatedSample.rgb, shapeMask);
          }
        }
        
        color = applyBitDepth(color);
        color = applyDithering(color, gl_FragCoord.xy);
        
        return vec4(color, alpha);
      }
      
      // ===== CRT EFFECT FUNCTIONS =====
       vec4 applyCRT(vec2 uv, vec4 inputColor, float mouseEffect, float interactionMultiplier) {

         vec3 color = applyCRTColorEffects(inputColor.rgb, uv, mouseEffect, interactionMultiplier);
         return vec4(color, inputColor.a);
      }
      
      // ===== GLITCH EFFECT FUNCTIONS =====
      vec4 applyGlitch(vec2 uv, vec4 inputColor, float mouseEffect, float interactionMultiplier) {
        vec3 color = inputColor.rgb;
        
        if (signalDropoutFreq > 0.0) {
          float effectiveDropout = signalDropoutFreq;
                     if (signalDropoutInteractive) effectiveDropout *= interactionMultiplier;
          
          vec2 dropoutSize = vec2(signalDropoutSize * 5.0);
          vec2 dropoutUV = floor(uv / dropoutSize) * dropoutSize;
          float dropoutNoise = random3(vec3(dropoutUV, floor(time * 6.0)));
          
          if (dropoutNoise < effectiveDropout * 3.0) {
            if (dropoutNoise < effectiveDropout * 1.0) {
              color = vec3(0.0);
            } else if (dropoutNoise < effectiveDropout * 2.0) {
              color = vec3(1.0);
            } else {
              color = vec3(1.0, 0.0, 0.0);
            }
          }
        }
        
        if (syncErrorFreq > 0.0) {
          float effectiveSync = syncErrorAmount;
                     if (syncErrorsInteractive) effectiveSync *= interactionMultiplier;
          
          float lineNoise = random(vec2(floor(uv.y * 100.0), floor(time * 8.0)));
          if (lineNoise < syncErrorFreq * 10.0) {
            float displacement = (random(vec2(uv.y, time)) - 0.5) * effectiveSync * 20.0;
            vec2 syncUV = vec2(uv.x + displacement, uv.y);
            color = sampleWithEffects(syncUV, mouseEffect, interactionMultiplier).rgb;
          }
        }
        
         if (interferenceIntensity > 0.0) {
           float effectiveInterference = interferenceIntensity;
           if (interferenceLinesInteractive) effectiveInterference *= interactionMultiplier;
           
           float interference = sin((uv.y + time * interferenceSpeed * 2.0) * 100.0);
           color += vec3(interference * effectiveInterference);
         }
         
         if (frameGhostAmount > 0.0) {
           float effectiveGhost = frameGhostAmount;
           if (frameGhostingInteractive) effectiveGhost *= interactionMultiplier;
           
           vec2 ghost1 = uv + vec2(sin(time * 0.5) * 0.02, cos(time * 0.3) * 0.02);
           vec2 ghost2 = uv + vec2(sin(time * 0.7) * 0.03, cos(time * 0.5) * 0.015);
           vec2 ghost3 = uv + vec2(sin(time * 0.9) * 0.025, cos(time * 0.7) * 0.02);
           
                       vec3 ghostColor1 = sampleWithGeometricEffects(ghost1, mouseEffect, interactionMultiplier).rgb;
            vec3 ghostColor2 = sampleWithGeometricEffects(ghost2, mouseEffect, interactionMultiplier).rgb;
            vec3 ghostColor3 = sampleWithGeometricEffects(ghost3, mouseEffect, interactionMultiplier).rgb;
           
           vec3 ghostMix = (ghostColor1 + ghostColor2 + ghostColor3) / 3.0;
           color = mix(color, ghostMix, effectiveGhost);
         }
         
         if (stutterFreq > 0.0) {
           float stutterNoise = random(vec2(floor(time * 10.0), floor(uv.y * 50.0)));
           if (stutterNoise < stutterFreq * 5.0) {
             float frozenTime = floor(time * 3.0) / 3.0;
             vec2 stutterOffset = vec2(
               sin(frozenTime * 2.0) * 0.01,
               cos(frozenTime * 1.5) * 0.008
             );
                           color = sampleWithGeometricEffects(uv + stutterOffset, mouseEffect, interactionMultiplier).rgb;
           }
         }
         
         if (datamoshStrength > 0.0) {
           float effectiveDatamosh = datamoshStrength;
           if (datamoshingInteractive && mouseEffect > 0.0) {
             effectiveDatamosh *= interactionMultiplier;
             
             vec2 mouseUV = mousePx / resolution;
             vec2 distortion = (uv - mouseUV) * mouseEffect * effectiveDatamosh * 0.3;
             vec2 datamoshUV = uv + vec2(
               sin(distortion.x * 20.0 + time) * 0.02,
               cos(distortion.y * 15.0 + time) * 0.025
             ) * mouseEffect;
                           color = sampleWithGeometricEffects(datamoshUV, mouseEffect, interactionMultiplier).rgb;
            } else if (!datamoshingInteractive) {
              vec2 globalDistortion = vec2(
                sin(uv.x * 10.0 + time * 2.0) * effectiveDatamosh * 0.01,
                cos(uv.y * 8.0 + time * 1.5) * effectiveDatamosh * 0.012
              );
              color = sampleWithGeometricEffects(uv + globalDistortion, mouseEffect, interactionMultiplier).rgb;
           }
         }
         
         float effectiveShift = rgbShift;
         if (rgbShiftInteractive) effectiveShift *= interactionMultiplier;
         
         if (effectiveShift > 0.0) {
           vec2 shiftOffset = vec2(effectiveShift, 0.0) * sin(time * 10.0 + uv.y * 50.0);
           float r = sampleWithGeometricEffects(uv - shiftOffset, mouseEffect, interactionMultiplier).r;
           float g = color.g;
           float b = sampleWithGeometricEffects(uv + shiftOffset, mouseEffect, interactionMultiplier).b;
           color = vec3(r, g, b);
         }
         
         if (bitCrushDepth > 0.0) {
           float effectiveDepth = bitCrushDepth;
           if (bitCrushInteractive) effectiveDepth *= interactionMultiplier;
           
           float levels = max(2.0, 32.0 - effectiveDepth * 4.0);
           color = floor(color * levels) / levels;
         }
         
         if (lineDisplacement > 0.0) {
           float effectiveDisplacement = lineDisplacement;
           if (lineDisplacementInteractive) effectiveDisplacement *= interactionMultiplier;
           
           float lineNoise = random(vec2(floor(uv.y * 100.0), floor(time * 8.0)));
           if (lineNoise > 0.95) {
             float displacement = (random(vec2(uv.y, time)) - 0.5) * effectiveDisplacement;
             float distFromCenter = abs(uv.x - 0.5) * 2.0;
             float triangularStrength = 0.2 + distFromCenter * 0.8;
             vec2 displacedUV = uv + vec2(displacement * triangularStrength * 50.0, 0.0);
                           color = sampleWithGeometricEffects(displacedUV, mouseEffect, interactionMultiplier).rgb;
           }
         }
         
         if (digitalNoise > 0.0) {
           float effectiveNoise = digitalNoise;
           if (digitalNoiseInteractive) effectiveNoise *= interactionMultiplier;
           
           float noise = random(uv + time);
           if (noise > (1.0 - effectiveNoise * 0.1)) {
             color = mix(color, vec3(noise), effectiveNoise * 0.8);
           }
         }
         
         return vec4(color, inputColor.a);
      }
      
      void main() {
        vec2 uv = vUv;
        
        float mouseEffect = 0.0;
        float interactionMultiplier = 1.0;
        if (interactionEnabled) {
          mouseEffect = getInteractionEffect(gl_FragCoord.xy, mousePx, radiusPx);
          interactionMultiplier = 1.0 + (mouseEffect * intensity);
        }
        
        vec2 baseUV = uv;
        vec2 curvedUV = uv;
        if (crtEnabled && curvature > 0.0) {
          float effectiveCurvature = curvature;
          if (curvatureInteractive) {
            effectiveCurvature = curvature * (1.0 + mouseEffect * intensity);
            effectiveCurvature = clamp(effectiveCurvature, 0.0, 25.0);
          }
          
          curvedUV = uv * 2.0 - 1.0;
          vec2 offset = abs(curvedUV.yx) * effectiveCurvature / 20.0;
          curvedUV = curvedUV + curvedUV * offset * offset;
          curvedUV = curvedUV * 0.5 + 0.5;
        }
        
        vec2 samplingUV = (crtEnabled && curvature > 0.0) ? curvedUV : baseUV;
        
        vec4 color = texture2D(u_texture, samplingUV);
        
        if (pixelationEnabled) {
          color = applyPixelation(samplingUV, color, mouseEffect, interactionMultiplier);
        }
        
        if (glitchEnabled) {
          color = applyGlitch(samplingUV, color, mouseEffect, interactionMultiplier);
        }
        
        if (crtEnabled) {
          color = applyCRT(samplingUV, color, mouseEffect, interactionMultiplier);
        }
        
        gl_FragColor = color;
      }
    `,
  };

  /* --------------------------------------------------
   *  Shared Renderer Architecture
   * ------------------------------------------------*/
  class GlitchGLRenderer {
    constructor() {
      this.glitchSystems = new Map();
      this.targetElements = new Map();
      this.renderers = new Map();

      this.mouse = new THREE.Vector2();
      this.lastMousePos = new THREE.Vector2();

      this.mouseVelocity = 0;
      this.lastMoveTime = 0;
      this.currentEffectScale = 0;
      this.targetEffectScale = 0;

      this.onMouseMove = this.onMouseMove.bind(this);
      this.onTouchStart = this.onTouchStart.bind(this);
      this.onTouchMove = this.onTouchMove.bind(this);
      this.onTouchEnd = this.onTouchEnd.bind(this);

      document.addEventListener("mousemove", this.onMouseMove);
      document.addEventListener("touchstart", this.onTouchStart, {
        passive: false,
      });
      document.addEventListener("touchmove", this.onTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onTouchEnd, {
        passive: false,
      });
    }

    addGlitchSystem(instanceId, targetElement, options) {
      const is3D = !!targetElement.dataset.modelSrc;

      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        powerPreference: "high-performance",
        alpha: true,
      });

      const pixelRatio = Math.min(window.devicePixelRatio, 2);
      renderer.setPixelRatio(pixelRatio);
      renderer.setClearColor(0x000000, 0);

      const scene = new THREE.Scene();
      const camera = is3D
        ? new THREE.PerspectiveCamera(75, 1, 0.1, 1000)
        : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);

      if (is3D) {
        camera.position.z = 2;
        scene.background = null;
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(1, 1, 1);
        scene.add(directionalLight);
      }

      const postScene = is3D ? new THREE.Scene() : null;
      const postCamera = is3D
        ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
        : null;

      const renderTarget1 = new THREE.WebGLRenderTarget(1, 1);
      const renderTarget2 = new THREE.WebGLRenderTarget(1, 1);

      const canvas = renderer.domElement;
      canvas.setAttribute("data-glitch-target", instanceId);

      targetElement.parentNode.insertBefore(canvas, targetElement.nextSibling);

      this.renderers.set(instanceId, {
        renderer,
        scene,
        camera,
        postScene,
        postCamera,
        renderTarget1,
        renderTarget2,
        is3D,
      });

      this.glitchSystems.set(instanceId, {
        element: targetElement,
        options: options,
        inView: false,
        observer: null,
        originalVisibility: targetElement.style.visibility,
        isMouseOver: false,
        currentMouse: new THREE.Vector2(),
        lastMousePos: new THREE.Vector2(),
        targetRotation: new THREE.Vector2(),
        isVideo: targetElement.tagName.toLowerCase() === "video",
        is3D: is3D,
        model: null,
        elementTexture: null,
        glitchMaterial: null,
        quad: null,
        time: 0,
        needsRender: true,
        lastRenderTime: 0,
        lastContainerAspect: null,
      });

      this.targetElements.set(instanceId, targetElement);

      if (targetElement.tagName.toLowerCase() === "video") {
        const isSafari = /^((?!chrome|android).)*safari/i.test(
          navigator.userAgent
        );
        if (isSafari) {
          if (!targetElement.hasAttribute("playsinline")) {
            targetElement.setAttribute("playsinline", "");
          }
          if (!targetElement.hasAttribute("muted")) {
            targetElement.setAttribute("muted", "");
          }

          const ensureVideoPlaying = () => {
            if (targetElement.paused) {
              targetElement.play().catch((e) => {
                console.warn("glitchGL: Video play failed:", e);
              });
            }
          };

          document.addEventListener("click", ensureVideoPlaying, {
            once: true,
          });
          document.addEventListener("touchstart", ensureVideoPlaying, {
            once: true,
          });

          setTimeout(() => {
            if (targetElement.paused) {
              targetElement.play().catch(() => {});
            }
          }, 100);
        }
      }

      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver(
          (entries) => {
            const systemData = this.glitchSystems.get(instanceId);
            if (systemData) {
              systemData.inView = entries[0].isIntersecting;
              if (systemData.inView) {
                this.triggerRender(instanceId);
              }
            }
          },
          {
            root: null,
            threshold: 0,
            rootMargin: "500px",
          }
        );

        observer.observe(targetElement);
        this.glitchSystems.get(instanceId).observer = observer;
      } else {
        this.glitchSystems.get(instanceId).inView = true;
      }

      this.glitchSystems.get(instanceId).radiusPx = this.getInteractionRadiusPx(
        this.glitchSystems.get(instanceId).options,
        targetElement
      );

      this.initializeGlitchEffect(instanceId).then(() => {
        if (this.glitchSystems.has(instanceId)) {
          targetElement.style.visibility = "hidden";
        }
      });
    }

    async initializeGlitchEffect(instanceId) {
      const systemData = this.glitchSystems.get(instanceId);
      const rendererData = this.renderers.get(instanceId);

      if (!systemData || !rendererData) return;

      if (rendererData.is3D) {
        systemData.model = await this.loadModel(
          systemData.element.dataset.modelSrc,
          rendererData.scene,
          systemData.options
        );

        const rect = systemData.element.getBoundingClientRect();
        systemData.elementTexture = new THREE.WebGLRenderTarget(
          rect.width,
          rect.height
        );
      } else {
        systemData.elementTexture = await this.elementToTexture(
          systemData.element,
          systemData.options
        );

        const rect = systemData.element.getBoundingClientRect();
        systemData.lastContainerAspect = rect.width / rect.height;
      }

      const geometry = new THREE.PlaneGeometry(2, 2);

      const effectInputTexture = rendererData.is3D
        ? systemData.elementTexture.texture
        : systemData.elementTexture;

      systemData.glitchMaterial = await this.createCombinedMaterial(
        systemData.options,
        effectInputTexture,
        systemData.element,
        systemData,
        rendererData
      );

      systemData.quad = new THREE.Mesh(geometry, systemData.glitchMaterial);
      systemData.quad.position.z = -1;

      if (!rendererData.is3D) {
        rendererData.scene.add(systemData.quad);
      } else {
        rendererData.postScene.add(systemData.quad);
      }
    }

    async loadModel(modelSrc, scene, options) {
      return new Promise((resolve, reject) => {
        if (typeof THREE === "undefined" || !THREE.GLTFLoader) {
          console.error(
            "glitchGL: THREE.js and THREE.GLTFLoader are required for model loading."
          );
          return reject("Missing THREE.js or GLTFLoader.");
        }

        const loader = new THREE.GLTFLoader();
        const urlBase = THREE.LoaderUtils.extractUrlBase(modelSrc);
        loader.setPath(urlBase);

        const filename = modelSrc.substring(urlBase.length);

        loader.load(
          filename,
          (gltf) => {
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = (options.modelScale || 1.5) / maxDim;

            model.scale.set(scale, scale, scale);
            model.position.sub(center.multiplyScalar(scale));

            scene.add(model);
            resolve(model);
          },
          undefined,
          (error) => {
            console.error(
              `glitchGL: Failed to load 3D model from ${modelSrc}`,
              error
            );
            reject(`Failed to load model: ${error}`);
          }
        );
      });
    }

    async createCombinedMaterial(
      options,
      texture,
      element,
      systemData,
      rendererData
    ) {
      return this.createEffectMaterial(
        "combined",
        options,
        texture,
        element,
        systemData,
        rendererData
      );
    }

    async createEffectMaterial(
      effectType,
      options,
      texture,
      element,
      systemData,
      rendererData
    ) {
      let fragmentShader = shaders.combined;

      const isText = !["IMG", "VIDEO", "CANVAS", "SVG"].includes(
        element.tagName.toUpperCase()
      );

      const interactionConfig = options.interaction || null;
      let interactionTexture = null;
      let interactionGradientTexture = null;
      if (
        interactionConfig &&
        interactionConfig.enabled &&
        interactionConfig.shape === "custom" &&
        interactionConfig.customUrl
      ) {
        try {
          const textures = await this.loadCustomInteractionTexture(
            interactionConfig.customUrl
          );
          if (textures) {
            interactionTexture = textures.texture;
            interactionGradientTexture = textures.gradientTexture;
          }
        } catch (error) {
          console.error(
            "glitchGL: Failed to load custom interaction texture, using default.",
            error
          );
          interactionTexture = null;
          interactionGradientTexture = null;
        }
      } else {
      }

      let interactionShape = interactionConfig?.shape || "circle";
      let interactionTextureAspect = 1.0;

      if (interactionTexture && interactionTexture.image) {
        const img = interactionTexture.image;
        if (img.width && img.height > 0) {
          interactionTextureAspect = img.width / img.height;
        }
      }

      let textureAspect = 1.0;
      if (texture && texture.image) {
        const image = texture.image;
        const width = image.width || image.videoWidth;
        const height = image.height || image.videoHeight;
        if (width && height > 0) {
          textureAspect = width / height;
        }
      }

      const material = new THREE.ShaderMaterial({
        vertexShader: shaders.vertex,
        fragmentShader: fragmentShader,
        uniforms: {
          u_texture: { value: texture },
          resolution: { value: new THREE.Vector2(1, 1) },
          time: { value: 0 },
          mousePx: { value: new THREE.Vector2(0, 0) },
          radiusPx: { value: systemData.radiusPx || 100.0 },
          aspect: { value: 1.0 },
          pixelRatio: { value: rendererData.renderer.getPixelRatio() },
          intensity: { value: options.intensity || 1.0 },
          textureAspect: { value: textureAspect },
          aspectCorrectionEnabled: {
            value:
              options.aspectCorrection === true &&
              !(
                texture &&
                texture.userData &&
                texture.userData.objectFitHandled
              ),
          },

          pixelationEnabled: {
            value: options.effects.pixelation.enabled || false,
          },
          crtEnabled: { value: options.effects.crt.enabled || false },
          glitchEnabled: { value: options.effects.glitch.enabled || false },

          pixelSize: { value: options.effects.pixelation.pixelSize || 8 },
          pixelShape: {
            value: this.getPixelShapeValue(
              options.effects.pixelation.pixelShape || "square"
            ),
          },
          bitDepth: {
            value: this.getBitDepthValue(
              options.effects.pixelation.bitDepth || "none"
            ),
          },
          dithering: {
            value: this.getDitheringValue(
              options.effects.pixelation.dithering || "none"
            ),
          },
          pixelDirection: {
            value: this.getPixelDirectionValue(
              options.effects.pixelation.pixelDirection || "square"
            ),
          },
          interactionEnabled: {
            value: options.interaction?.enabled || false,
          },
          pixelSizeInteractive: {
            value: this.isEffectInteractive(options, "pixelation", "pixelSize"),
          },
          isText: { value: isText ? 1 : 0 },

          interactionShape: {
            value: this.getInteractionShapeValue(interactionShape),
          },
          interactionTexture: { value: interactionTexture || null },
          interactionGradientTexture: {
            value: interactionGradientTexture || null,
          },
          hasCustomInteractionTexture: { value: !!interactionTexture },
          interactionTextureAspect: { value: interactionTextureAspect },
          effectScale: { value: 1.0 },

          scanlineIntensity: {
            value:
              options.effects.crt.scanlineIntensity !== undefined
                ? options.effects.crt.scanlineIntensity
                : 0.5,
          },
          phosphorGlow: {
            value:
              options.effects.crt.phosphorGlow !== undefined
                ? options.effects.crt.phosphorGlow
                : 0.3,
          },
          curvature: {
            value:
              options.effects.crt.curvature !== undefined
                ? options.effects.crt.curvature
                : 6.0,
          },
          chromaticAberration: {
            value:
              options.effects.crt.chromaticAberration !== undefined
                ? options.effects.crt.chromaticAberration
                : 0.003,
          },
          scanlineThickness: {
            value:
              options.effects.crt.scanlineThickness !== undefined
                ? options.effects.crt.scanlineThickness
                : 0.8,
          },
          scanlineCount: {
            value:
              options.effects.crt.scanlineCount !== undefined
                ? options.effects.crt.scanlineCount
                : 0.0,
          },
          brightness: {
            value:
              options.effects.crt.brightness !== undefined
                ? options.effects.crt.brightness
                : 1.0,
          },
          flicker: {
            value:
              options.effects.crt.flicker !== undefined
                ? options.effects.crt.flicker
                : false,
          },
          flickerIntensity: {
            value:
              options.effects.crt.flickerIntensity !== undefined
                ? options.effects.crt.flickerIntensity
                : 0.5,
          },
          lineMovement: {
            value:
              options.effects.crt.lineMovement !== undefined
                ? options.effects.crt.lineMovement
                : false,
          },
          lineSpeed: {
            value:
              options.effects.crt.lineSpeed !== undefined
                ? options.effects.crt.lineSpeed
                : 1.0,
          },
          lineDirection: {
            value: this.getLineDirectionValue(
              options.effects.crt.lineDirection || "up"
            ),
          },
          interactionEnabled: {
            value: options.interaction?.enabled || false,
          },
          chromaticAberrationInteractive: {
            value: this.isEffectInteractive(
              options,
              "crt",
              "chromaticAberration"
            ),
          },
          scanlinesInteractive: {
            value: this.isEffectInteractive(options, "crt", "scanlines"),
          },
          phosphorGlowInteractive: {
            value: this.isEffectInteractive(options, "crt", "phosphorGlow"),
          },
          curvatureInteractive: {
            value: this.isEffectInteractive(options, "crt", "curvature"),
          },

          pixelationEnabled: {
            value: options.effects.pixelation.enabled || false,
          },
          pixelSize: { value: options.effects.pixelation.pixelSize || 8 },

          rgbShift: {
            value:
              options.effects.glitch.rgbShift !== undefined
                ? options.effects.glitch.rgbShift
                : 0.005,
          },
          digitalNoise: {
            value:
              options.effects.glitch.digitalNoise !== undefined
                ? options.effects.glitch.digitalNoise
                : 0.1,
          },
          lineDisplacement: {
            value:
              options.effects.glitch.lineDisplacement !== undefined
                ? options.effects.glitch.lineDisplacement
                : 0.01,
          },

          bitCrushDepth: {
            value:
              options.effects.glitch.bitCrushDepth !== undefined
                ? options.effects.glitch.bitCrushDepth
                : 0.0,
          },

          signalDropoutFreq: {
            value:
              options.effects.glitch.signalDropoutFreq !== undefined
                ? options.effects.glitch.signalDropoutFreq
                : 0.0,
          },
          signalDropoutSize: {
            value:
              options.effects.glitch.signalDropoutSize !== undefined
                ? options.effects.glitch.signalDropoutSize
                : 0.1,
          },
          syncErrorFreq: {
            value:
              options.effects.glitch.syncErrorFreq !== undefined
                ? options.effects.glitch.syncErrorFreq
                : 0.0,
          },
          syncErrorAmount: {
            value:
              options.effects.glitch.syncErrorAmount !== undefined
                ? options.effects.glitch.syncErrorAmount
                : 0.05,
          },
          interferenceSpeed: {
            value:
              options.effects.glitch.interferenceSpeed !== undefined
                ? options.effects.glitch.interferenceSpeed
                : 1.0,
          },
          interferenceIntensity: {
            value:
              options.effects.glitch.interferenceIntensity !== undefined
                ? options.effects.glitch.interferenceIntensity
                : 0.0,
          },
          frameGhostAmount: {
            value:
              options.effects.glitch.frameGhostAmount !== undefined
                ? options.effects.glitch.frameGhostAmount
                : 0.0,
          },
          stutterFreq: {
            value:
              options.effects.glitch.stutterFreq !== undefined
                ? options.effects.glitch.stutterFreq
                : 0.0,
          },
          datamoshStrength: {
            value:
              options.effects.glitch.datamoshStrength !== undefined
                ? options.effects.glitch.datamoshStrength
                : 0.0,
          },

          interactionEnabled: {
            value: options.interaction?.enabled || false,
          },
          rgbShiftInteractive: {
            value: this.isEffectInteractive(options, "glitch", "rgbShift"),
          },
          digitalNoiseInteractive: {
            value: this.isEffectInteractive(options, "glitch", "digitalNoise"),
          },
          lineDisplacementInteractive: {
            value: this.isEffectInteractive(
              options,
              "glitch",
              "lineDisplacement"
            ),
          },
          bitCrushInteractive: {
            value: this.isEffectInteractive(options, "glitch", "bitCrushing"),
          },

          signalDropoutInteractive: {
            value: this.isEffectInteractive(options, "glitch", "signalDropout"),
          },
          syncErrorsInteractive: {
            value: this.isEffectInteractive(options, "glitch", "syncErrors"),
          },
          interferenceLinesInteractive: {
            value: this.isEffectInteractive(
              options,
              "glitch",
              "interferenceLines"
            ),
          },
          frameGhostingInteractive: {
            value: this.isEffectInteractive(options, "glitch", "frameGhosting"),
          },
          stutterFreezeInteractive: {
            value: this.isEffectInteractive(options, "glitch", "stutterFreeze"),
          },
          datamoshingInteractive: {
            value: this.isEffectInteractive(options, "glitch", "datamoshing"),
          },

          interactionTextureAspect: { value: interactionTextureAspect },
        },
        transparent: true,
      });

      if (texture) {
        texture.needsUpdate = true;
        texture.flipY = true;
      }
      return material;
    }

    getPixelShapeValue(shape) {
      const map = {
        square: 0,
        circle: 1,
        diamond: 2,
        cross: 3,
        plus: 4,
      };
      return map[shape] || 0;
    }

    isEffectInteractive(options, effectType, effectName) {
      const interaction = options.interaction;
      if (
        !interaction ||
        !interaction.enabled ||
        !interaction.effects ||
        !interaction.effects[effectType]
      ) {
        return false;
      }
      return interaction.effects[effectType].includes(effectName);
    }

    getInteractionShapeValue(shape) {
      const map = {
        circle: 0,
        square: 1,
        diamond: 2,
        cross: 3,
        plus: 4,
        custom: 5,
      };
      return map[shape] || 0;
    }

    getCustomShapeSize(options, element, mouseRadius = 0.2) {
      let interactionConfig = null;
      if (options.effects.pixelation.enabled) {
        interactionConfig = options.effects.pixelation.interaction;
      } else if (options.effects.crt.enabled) {
        interactionConfig = options.effects.crt.interaction;
      } else if (options.effects.glitch.enabled) {
        interactionConfig = options.effects.glitch.interaction;
      }

      if (!interactionConfig) return 1.0;

      const rawSize = interactionConfig.customSize;

      if (rawSize === undefined || rawSize === null || rawSize === "auto") {
        return 1.0;
      }

      if (typeof rawSize === "number" && !isNaN(rawSize)) {
        return rawSize;
      }

      if (typeof rawSize !== "string") {
        return 1.0;
      }

      const cssMatch = rawSize
        .trim()
        .match(/^(-?\d*\.?\d+)(px|vw|vh|vmin|vmax|rem|em)?$/i);
      if (!cssMatch) {
        console.warn(
          `glitchGL: Could not parse customSize value "${rawSize}". Falling back to 1.0.`
        );
        return 1.0;
      }

      const numeric = parseFloat(cssMatch[1]);
      const unit = (cssMatch[2] || "px").toLowerCase();

      let pixels = numeric;
      switch (unit) {
        case "px":
          break;
        case "vw":
          pixels = (numeric / 100) * window.innerWidth;
          break;
        case "vh":
          pixels = (numeric / 100) * window.innerHeight;
          break;
        case "vmin":
          pixels =
            (numeric / 100) * Math.min(window.innerWidth, window.innerHeight);
          break;
        case "vmax":
          pixels =
            (numeric / 100) * Math.max(window.innerWidth, window.innerHeight);
          break;
        case "rem": {
          const rootFontSize =
            parseFloat(getComputedStyle(document.documentElement).fontSize) ||
            16;
          pixels = numeric * rootFontSize;
          break;
        }
        case "em": {
          let fontSize = 16;
          if (element) {
            const style = getComputedStyle(element);
            fontSize = parseFloat(style.fontSize) || fontSize;
          } else {
            fontSize =
              parseFloat(getComputedStyle(document.documentElement).fontSize) ||
              fontSize;
          }
          pixels = numeric * fontSize;
          break;
        }
        default:
          break;
      }

      let rectWidth = 0;
      let rectHeight = 0;
      if (element && typeof element.getBoundingClientRect === "function") {
        const rect = element.getBoundingClientRect();
        rectWidth = rect.width;
        rectHeight = rect.height;
      } else {
        rectWidth = window.innerWidth;
        rectHeight = window.innerHeight;
      }

      const radiusPx = mouseRadius * Math.min(rectWidth, rectHeight);
      if (radiusPx === 0) return 1.0;

      const radiusPixels = pixels / 2;

      const multiplier = radiusPixels / radiusPx;
      return isFinite(multiplier) && multiplier > 0 ? multiplier : 1.0;
    }

    async loadCustomInteractionTexture(url) {
      if (!url) return null;

      try {
        const img = new Image();
        img.crossOrigin = "anonymous";

        const isSVG = url.toLowerCase().endsWith(".svg");

        if (isSVG && navigator.userAgent.includes("Firefox")) {
          try {
            const response = await fetch(url);
            const svgText = await response.text();
            const blob = new Blob([svgText], { type: "image/svg+xml" });
            const blobUrl = URL.createObjectURL(blob);

            await new Promise((resolve, reject) => {
              img.onload = () => {
                URL.revokeObjectURL(blobUrl);
                resolve();
              };
              img.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                reject();
              };
              img.src = blobUrl;
            });
          } catch (e) {
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = url;
            });
          }
        } else {
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
          });
        }

        let texture;
        let gradientTexture = null;

        if (isSVG) {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d", { willReadFrequently: true });

          const size = 512;
          canvas.width = size;
          canvas.height = size;

          ctx.clearRect(0, 0, size, size);

          if (navigator.userAgent.includes("Firefox")) {
            await new Promise((resolve) => setTimeout(resolve, 100));

            if (!img.width || !img.height) {
              img.width = size;
              img.height = size;
            }
          }

          const padding = 0.7;
          const scale = Math.min(size / img.width, size / img.height) * padding;
          const scaledWidth = img.width * scale;
          const scaledHeight = img.height * scale;
          const x = (size - scaledWidth) / 2;
          const y = (size - scaledHeight) / 2;
          ctx.drawImage(img, x, y, scaledWidth, scaledHeight);

          const checkData = ctx.getImageData(0, 0, size, size);
          let pixelsWithContent = 0;
          let maxRGB = 0;
          let samplePixels = [];

          for (let i = 0; i < checkData.data.length; i += 4) {
            const r = checkData.data[i];
            const g = checkData.data[i + 1];
            const b = checkData.data[i + 2];
            const a = checkData.data[i + 3];

            if (r > 0 || g > 0 || b > 0 || a > 0) {
              pixelsWithContent++;
              maxRGB = Math.max(maxRGB, r, g, b);
            }

            if (
              samplePixels.length < 10 &&
              (r > 0 || g > 0 || b > 0 || a > 0)
            ) {
              samplePixels.push([r, g, b, a]);
            }
          }
          if (pixelsWithContent > 0) {
            const data = checkData.data;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              const a = data[i + 3];

              if (r > 0 || g > 0 || b > 0 || a > 0) {
                data[i + 3] = 255;
              }
            }
            ctx.putImageData(checkData, 0, 0);
          } else {
            console.error("No content found in SVG after drawing!");

            if (navigator.userAgent.includes("Firefox")) {
              ctx.clearRect(0, 0, size, size);
              ctx.drawImage(img, 0, 0, size, size);

              const fallbackData = ctx.getImageData(0, 0, size, size);
              pixelsWithContent = 0;
              for (let i = 0; i < fallbackData.data.length; i += 4) {
                if (
                  fallbackData.data[i] > 0 ||
                  fallbackData.data[i + 1] > 0 ||
                  fallbackData.data[i + 2] > 0 ||
                  fallbackData.data[i + 3] > 0
                ) {
                  pixelsWithContent++;
                }
              }

              if (pixelsWithContent > 0) {
                ctx.putImageData(fallbackData, 0, 0);
              }
            }
          }

          texture = new THREE.CanvasTexture(canvas);

          if (img.width && img.height) {
            texture.image.originalWidth = img.width;
            texture.image.originalHeight = img.height;
          }

          gradientTexture = this.generateDistanceFieldTexture(canvas, size);

          const sampleX = Math.floor(canvas.width / 2) - 25;
          const sampleY = Math.floor(canvas.height / 2) - 25;
          const imageData = ctx.getImageData(sampleX, sampleY, 50, 50);
          let hasAlpha = false;
          let opaquePixels = 0;
          for (let i = 3; i < imageData.data.length; i += 4) {
            if (imageData.data[i] === 255) opaquePixels++;
            if (imageData.data[i] > 0 && imageData.data[i] < 255) {
              hasAlpha = true;
            }
          }
        } else {
          texture = new THREE.Texture(img);

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          canvas.width = 512;
          canvas.height = 512;

          const padding = 0.7;
          const scale = Math.min(512 / img.width, 512 / img.height) * padding;
          const scaledWidth = img.width * scale;
          const scaledHeight = img.height * scale;
          const x = (512 - scaledWidth) / 2;
          const y = (512 - scaledHeight) / 2;
          ctx.drawImage(img, x, y, scaledWidth, scaledHeight);

          gradientTexture = this.generateDistanceFieldTexture(canvas, 512);
        }

        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.format = THREE.RGBAFormat;
        texture.needsUpdate = true;

        if (gradientTexture) {
          gradientTexture.minFilter = THREE.LinearFilter;
          gradientTexture.magFilter = THREE.LinearFilter;
          gradientTexture.format = THREE.RGBAFormat;
          gradientTexture.needsUpdate = true;
        }

        return { texture, gradientTexture };
      } catch (error) {
        console.warn(
          `glitchGL: Failed to load custom interaction texture from ${url}:`,
          error
        );
        return null;
      }
    }

    getBitDepthValue(depth) {
      const map = {
        none: 0,
        "1-bit": 1,
        "4-bit": 2,
        "8-bit": 3,
      };
      return map[depth] || 0;
    }

    getDitheringValue(dithering) {
      const map = {
        none: 0,
        "floyd-steinberg": 1,
        bayer: 2,
      };
      return map[dithering] || 0;
    }

    getPixelDirectionValue(direction) {
      const map = {
        square: 0,
        horizontal: 1,
        vertical: 2,
      };
      return map[direction] || 0;
    }

    getLineDirectionValue(direction) {
      const map = {
        up: 0,
        down: 1,
        left: 2,
        right: 3,
      };
      return map[direction] || 0;
    }

    async elementToTexture(element, options = {}) {
      if (element.tagName.toLowerCase() === "video") {
        const isSafari = /^((?!chrome|android).)*safari/i.test(
          navigator.userAgent
        );

        await new Promise((resolve) => {
          const minReadyState = isSafari ? 2 : 1;

          if (element.readyState >= minReadyState) {
            resolve();
          } else {
            const eventName = isSafari ? "loadeddata" : "loadedmetadata";
            element.addEventListener(eventName, resolve, { once: true });
          }
        });

        if (element.paused) {
          try {
            await element.play();
          } catch (e) {
            console.warn(
              "glitchGL: Could not auto-play video, user interaction may be required:",
              e
            );
          }
        }

        const texture = new THREE.VideoTexture(element);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.format = THREE.RGBFormat;

        if (isSafari) {
          texture.generateMipmaps = false;
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;

          texture.needsUpdate = true;

          element.addEventListener("timeupdate", () => {
            texture.needsUpdate = true;
          });
        }

        return texture;
      } else {
        const canvas = await elementToCanvas(element, options);
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.format = THREE.RGBAFormat;
        texture.premultiplyAlpha = false;

        const computedStyle = window.getComputedStyle(element);
        const objectFit = computedStyle.objectFit || "fill";
        texture.userData = {
          objectFitHandled:
            ["img", "video"].includes(element.tagName.toLowerCase()) &&
            ["cover", "fill", "contain", "none", "scale-down"].includes(
              objectFit
            ),
        };

        return texture;
      }
    }

    generateDistanceFieldTexture(sourceCanvas, size) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = size;
      canvas.height = size;

      const filterSupported = "filter" in ctx;

      if (filterSupported) {
        const outerCanvas = document.createElement("canvas");
        const outerCtx = outerCanvas.getContext("2d");
        outerCanvas.width = size;
        outerCanvas.height = size;

        const innerCanvas = document.createElement("canvas");
        const innerCtx = innerCanvas.getContext("2d");
        innerCanvas.width = size;
        innerCanvas.height = size;

        outerCtx.drawImage(sourceCanvas, 0, 0);
        innerCtx.drawImage(sourceCanvas, 0, 0);

        outerCtx.filter = "blur(8px)";
        outerCtx.drawImage(outerCanvas, 0, 0);
        outerCtx.filter = "blur(4px)";
        outerCtx.drawImage(outerCanvas, 0, 0);

        innerCtx.filter = "blur(3px)";
        innerCtx.drawImage(innerCanvas, 0, 0);
        innerCtx.filter = "blur(1px)";
        innerCtx.drawImage(innerCanvas, 0, 0);

        const outerData = outerCtx.getImageData(0, 0, size, size);
        const innerData = innerCtx.getImageData(0, 0, size, size);

        const center = size / 2;
        const maxRadius = size / 2;

        const finalData = ctx.createImageData(size, size);

        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;

            const dx = x - center;
            const dy = y - center;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const normalizedDist = distance / maxRadius;

            const blendFactor = Math.pow(normalizedDist, 1.5);

            const outerAlpha = outerData.data[idx + 3];
            const innerAlpha = innerData.data[idx + 3];
            const blendedAlpha =
              innerAlpha * (1 - blendFactor) + outerAlpha * blendFactor;

            finalData.data[idx] = blendedAlpha;
            finalData.data[idx + 1] = blendedAlpha;
            finalData.data[idx + 2] = blendedAlpha;
            finalData.data[idx + 3] = 255;
          }
        }

        ctx.putImageData(finalData, 0, 0);
      } else {
        const sourceData = sourceCanvas
          .getContext("2d")
          .getImageData(0, 0, size, size);
        const data = sourceData.data;

        const blurPasses = 3;
        const blurRadius = 8;

        const tempData = new Uint8ClampedArray(data.length);

        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3];
          tempData[i] = alpha;
          tempData[i + 1] = alpha;
          tempData[i + 2] = alpha;
          tempData[i + 3] = 255;
        }

        for (let pass = 0; pass < blurPasses; pass++) {
          const passData = new Uint8ClampedArray(tempData);

          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              let sum = 0;
              let count = 0;

              for (let dx = -blurRadius; dx <= blurRadius; dx++) {
                const nx = x + dx;
                if (nx >= 0 && nx < size) {
                  sum += passData[(y * size + nx) * 4];
                  count++;
                }
              }

              const idx = (y * size + x) * 4;
              const value = Math.round(sum / count);
              tempData[idx] = value;
              tempData[idx + 1] = value;
              tempData[idx + 2] = value;
            }
          }

          for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
              let sum = 0;
              let count = 0;

              for (let dy = -blurRadius; dy <= blurRadius; dy++) {
                const ny = y + dy;
                if (ny >= 0 && ny < size) {
                  sum += tempData[(ny * size + x) * 4];
                  count++;
                }
              }

              const idx = (y * size + x) * 4;
              const value = Math.round(sum / count);
              tempData[idx] = value;
              tempData[idx + 1] = value;
              tempData[idx + 2] = value;
            }
          }
        }

        const imageData = ctx.createImageData(size, size);
        imageData.data.set(tempData);
        ctx.putImageData(imageData, 0, 0);
      }

      return new THREE.CanvasTexture(canvas);
    }

    onMouseMove(event) {
      this.handleInteraction(event);
    }

    onTouchStart(event) {
      if (event.touches.length > 0) {
        const touch = event.touches[0];

        this.mouseVelocity = 0;
        this.lastMousePos.set(touch.clientX, touch.clientY);
        this.handleInteraction(touch);
      }
    }

    onTouchMove(event) {
      if (event.touches.length > 0) {
        event.preventDefault();

        const touch = event.touches[0];
        this.handleInteraction(touch);
      }
    }

    onTouchEnd(event) {
      for (const [instanceId, systemData] of this.glitchSystems) {
        systemData.isMouseOver = false;
      }
    }

    handleInteraction(event) {
      const currentPos = new THREE.Vector2(event.clientX, event.clientY);
      const instantVelocity = currentPos.distanceTo(this.lastMousePos);

      const smoothingFactor = 0.3;
      this.mouseVelocity =
        this.mouseVelocity * (1 - smoothingFactor) +
        instantVelocity * smoothingFactor;

      this.lastMousePos.copy(currentPos);

      const currentTime = performance.now();
      this.lastMoveTime = currentTime;

      for (const [instanceId, systemData] of this.glitchSystems) {
        const rect = systemData.element.getBoundingClientRect();
        const isOver =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom;

        systemData.isMouseOver = isOver;

        if (isOver) {
          const relativeX = event.clientX - rect.left;
          const relativeY = event.clientY - rect.top;

          systemData.currentMouse.set(relativeX, rect.height - relativeY);
          systemData.needsRender = true;

          if (systemData.is3D) {
            const tiltFactor = systemData.options.tiltFactor || 0.2;
            const mouseX = (relativeX / rect.width) * 2 - 1;
            const mouseY = -(relativeY / rect.height) * 2 + 1;
            systemData.targetRotation.x = mouseY * tiltFactor;
            systemData.targetRotation.y = mouseX * tiltFactor;
          }
        }
      }
    }

    animate() {
      if (!isAnimating) return;

      const currentTime = performance.now();
      const timeSinceLastMove = currentTime - this.lastMoveTime;

      let velocityEnabled = false;
      for (const [instanceId, systemData] of this.glitchSystems) {
        if (systemData.options.interaction?.velocity !== false) {
          velocityEnabled = true;
          break;
        }
      }

      if (velocityEnabled) {
        if (timeSinceLastMove > 16) {
          const decayRate = 0.95;
          this.mouseVelocity *= decayRate;

          if (this.mouseVelocity < 0.01) {
            this.mouseVelocity = 0;
          }
        }

        const maxVelocity = 30;
        const normalizedVelocity = Math.min(
          this.mouseVelocity / maxVelocity,
          1
        );

        this.targetEffectScale = Math.pow(normalizedVelocity, 0.6);

        const easeSpeed = 0.15;
        const scaleDiff = this.targetEffectScale - this.currentEffectScale;
        if (Math.abs(scaleDiff) > 0.001) {
          this.currentEffectScale += scaleDiff * easeSpeed;
        } else {
          this.currentEffectScale = this.targetEffectScale;
        }
      } else {
        this.currentEffectScale = 1;
      }

      let anySystemNeedsRender = false;

      for (const [instanceId, systemData] of this.glitchSystems) {
        if (!systemData.inView) continue;

        const rendererData = this.renderers.get(instanceId);
        if (!rendererData) continue;

        if (
          !systemData.glitchMaterial ||
          (systemData.is3D && !systemData.elementTexture)
        ) {
          continue;
        }

        const { renderer, scene, camera, postScene, postCamera, is3D } =
          rendererData;

        const hasTimeBasedEffects = this.checkTimeBasedEffects(systemData);

        const shouldRender =
          systemData.needsRender || hasTimeBasedEffects || systemData.isVideo;

        if (!shouldRender) {
          continue;
        }

        anySystemNeedsRender = true;

        systemData.time += 0.016;

        if (systemData.is3D && systemData.model) {
          const tiltSpeed = systemData.options.tiltSpeed || 0.05;
          systemData.model.rotation.x +=
            (systemData.targetRotation.x - systemData.model.rotation.x) *
            tiltSpeed;
          systemData.model.rotation.y +=
            (systemData.targetRotation.y - systemData.model.rotation.y) *
            tiltSpeed;
        }

        const materialsToUpdate = [systemData.glitchMaterial].filter(Boolean);

        for (const material of materialsToUpdate) {
          if (!material) continue;

          material.uniforms.time.value = systemData.time;
          material.uniforms.mousePx.value.copy(systemData.currentMouse);
          material.uniforms.effectScale.value = this.currentEffectScale;

          const rect = systemData.element.getBoundingClientRect();
          material.uniforms.resolution.value.set(rect.width, rect.height);
          if (rect.height > 0) {
            material.uniforms.aspect.value = rect.width / rect.height;

            const texture = material.uniforms.u_texture.value;
            if (
              texture &&
              texture.userData &&
              texture.userData.objectFitHandled
            ) {
              const containerAspect = rect.width / rect.height;
              material.uniforms.textureAspect.value = containerAspect;
            }
          }

          const texture = material.uniforms.u_texture.value;
          if (texture && texture.isVideoTexture && systemData.isVideo) {
            const isSafari = /^((?!chrome|android).)*safari/i.test(
              navigator.userAgent
            );
            if (isSafari && systemData.element && !systemData.element.paused) {
              texture.needsUpdate = true;
            }
          }
        }

        if (is3D) {
          const rect = systemData.element.getBoundingClientRect();
          if (rect.height > 0) {
            camera.aspect = rect.width / rect.height;
            camera.updateProjectionMatrix();
          }
        }

        this.updateCanvasPosition(instanceId, systemData, renderer);

        if (is3D) {
          renderer.setRenderTarget(systemData.elementTexture);
          renderer.render(scene, camera);
          renderer.setRenderTarget(null);

          renderer.render(postScene, postCamera);
        } else {
          renderer.render(scene, camera);
        }

        systemData.needsRender = false;
        systemData.lastRenderTime = performance.now();
      }

      if (anySystemNeedsRender || this.hasAnyTimeBasedEffects()) {
        animationFrameId = requestAnimationFrame(() => this.animate());
      } else {
        animationFrameId = null;
      }
    }

    checkTimeBasedEffects(systemData) {
      const opts = systemData.options;
      if (!opts || !opts.effects) return false;

      const crt = opts.effects.crt;
      const glitch = opts.effects.glitch;

      if (crt && crt.enabled) {
        if (crt.flicker || crt.lineMovement) return true;
      }

      if (glitch && glitch.enabled) {
        if (
          glitch.rgbShift > 0 ||
          glitch.digitalNoise > 0 ||
          glitch.signalDropoutFreq > 0 ||
          glitch.syncErrorFreq > 0 ||
          glitch.interferenceIntensity > 0 ||
          glitch.frameGhostAmount > 0 ||
          glitch.stutterFreq > 0 ||
          glitch.datamoshStrength > 0
        ) {
          return true;
        }
      }

      return false;
    }

    hasAnyTimeBasedEffects() {
      for (const [instanceId, systemData] of this.glitchSystems) {
        if (systemData.inView && this.checkTimeBasedEffects(systemData)) {
          return true;
        }
      }
      return false;
    }

    updateCanvasPosition(instanceId, systemData, renderer) {
      const canvas = renderer.domElement;
      const element = systemData.element;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.opacity === "0" ||
        style.display === "none"
      ) {
        canvas.style.display = "none";
        return;
      }
      canvas.style.display = "block";

      if (renderer.width !== rect.width || renderer.height !== rect.height) {
        renderer.setSize(rect.width, rect.height);
        if (systemData.is3D && systemData.elementTexture) {
          systemData.elementTexture.setSize(rect.width, rect.height);
        }
      }

      if (
        !systemData.is3D &&
        systemData.elementTexture &&
        systemData.elementTexture.userData &&
        systemData.elementTexture.userData.objectFitHandled
      ) {
        const currentAspect = rect.width / rect.height;
        const previousAspect = systemData.lastContainerAspect || currentAspect;

        if (Math.abs(currentAspect - previousAspect) > 0.01) {
          systemData.lastContainerAspect = currentAspect;

          this.elementToTexture(systemData.element, systemData.options).then(
            (newTexture) => {
              if (systemData.elementTexture) {
                systemData.elementTexture.dispose();
              }
              systemData.elementTexture = newTexture;

              if (systemData.glitchMaterial) {
                systemData.glitchMaterial.uniforms.u_texture.value = newTexture;
                systemData.glitchMaterial.uniforms.textureAspect.value =
                  currentAspect;
                systemData.glitchMaterial.uniforms.aspectCorrectionEnabled.value =
                  systemData.options.aspectCorrection === true &&
                  !(
                    newTexture &&
                    newTexture.userData &&
                    newTexture.userData.objectFitHandled
                  );
              }

              systemData.needsRender = true;
            }
          );
        }
      }

      if (style.position === "static") {
        canvas.style.position = "fixed";
        canvas.style.top = `${rect.top}px`;
        canvas.style.left = `${rect.left}px`;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      } else {
        canvas.style.position = style.position;
        canvas.style.top = style.top;
        canvas.style.left = style.left;
        canvas.style.right = style.right;
        canvas.style.bottom = style.bottom;
        canvas.style.width = style.width;
        canvas.style.height = style.height;
      }

      canvas.style.margin = "0";
      canvas.style.padding = "0";
      canvas.style.transform =
        style.transform !== "none" ? style.transform : "";
      canvas.style.transformOrigin = style.transformOrigin;

      canvas.style.zIndex = style.zIndex;
      canvas.style.borderRadius = style.borderRadius;
      canvas.style.boxSizing = style.boxSizing;
      canvas.style.objectFit = style.objectFit;
      canvas.style.objectPosition = style.objectPosition;

      canvas.style.pointerEvents = "none";
    }

    removeGlitchSystem(instanceId, keepTargetHidden = false) {
      const systemData = this.glitchSystems.get(instanceId);
      const rendererData = this.renderers.get(instanceId);

      if (systemData) {
        if (!keepTargetHidden) {
          setTimeout(() => {
            systemData.element.style.visibility =
              systemData.originalVisibility || "";
          }, 16);
        }

        const canvas = document.querySelector(
          `canvas[data-glitch-target="${instanceId}"]`
        );
        if (canvas) {
          canvas.remove();
        }

        if (systemData.quad) {
          if (systemData.quad.geometry) systemData.quad.geometry.dispose();
          if (systemData.quad.material) systemData.quad.material.dispose();
        }

        if (systemData.model && rendererData.scene) {
          rendererData.scene.remove(systemData.model);
        }

        if (systemData.elementTexture) {
          systemData.elementTexture.dispose();
        }

        if (systemData.observer) {
          systemData.observer.disconnect();
        }

        this.glitchSystems.delete(instanceId);
        this.targetElements.delete(instanceId);
      }

      if (rendererData) {
        if (rendererData.renderer) {
          rendererData.renderer.dispose();
        }
        if (rendererData.renderTarget1) {
          rendererData.renderTarget1.dispose();
        }
        if (rendererData.renderTarget2) {
          rendererData.renderTarget2.dispose();
        }
        this.renderers.delete(instanceId);
      }
    }

    startAnimation() {
      if (!isAnimating) {
        isAnimating = true;
        this.animate();
      }
    }

    triggerRender(instanceId) {
      const systemData = this.glitchSystems.get(instanceId);
      if (systemData) {
        systemData.needsRender = true;
        if (!animationFrameId && isAnimating) {
          this.animate();
        }
      }
    }

    triggerRenderAll() {
      for (const [instanceId, systemData] of this.glitchSystems) {
        systemData.needsRender = true;
      }
      if (!animationFrameId && isAnimating) {
        this.animate();
      }
    }

    stopAnimation() {
      if (isAnimating) {
        isAnimating = false;
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      }
    }

    dispose() {
      this.stopAnimation();

      for (const [instanceId] of this.glitchSystems) {
        this.removeGlitchSystem(instanceId);
      }

      document.removeEventListener("mousemove", this.onMouseMove);
      document.removeEventListener("touchstart", this.onTouchStart);
      document.removeEventListener("touchmove", this.onTouchMove);
      document.removeEventListener("touchend", this.onTouchEnd);

      for (const [instanceId, rendererData] of this.renderers) {
        if (rendererData.renderer) {
          rendererData.renderer.dispose();
        }
      }

      this.glitchSystems.clear();
      this.targetElements.clear();
      this.renderers.clear();
    }

    getInteractionOptions(instanceOptions) {
      return instanceOptions.interaction || null;
    }

    getInteractionRadiusPx(options, element) {
      const interactionConfig = this.getInteractionOptions(options);
      if (!interactionConfig || !interactionConfig.customSize) {
        return 100.0;
      }

      const rawSize = interactionConfig.customSize;

      if (rawSize === undefined || rawSize === null || rawSize === "auto") {
        return 100.0;
      }

      if (typeof rawSize === "number") {
        return parseFloat(rawSize);
      }

      if (typeof rawSize !== "string") {
        return 100.0;
      }

      const cssMatch = rawSize
        .trim()
        .match(/^(-?\d*\.?\d+)(px|vw|vh|vmin|vmax|rem|em)?$/i);
      if (!cssMatch) {
        console.warn(
          `glitchGL: Could not parse customSize value "${rawSize}". Falling back to 100px.`
        );
        return 100.0;
      }

      const numeric = parseFloat(cssMatch[1]);
      const unit = (cssMatch[2] || "px").toLowerCase();

      let pixels = numeric;
      switch (unit) {
        case "px":
          break;
        case "vw":
          pixels = (numeric / 100) * window.innerWidth;
          break;
        case "vh":
          pixels = (numeric / 100) * window.innerHeight;
          break;
        case "vmin":
          pixels =
            (numeric / 100) * Math.min(window.innerWidth, window.innerHeight);
          break;
        case "vmax":
          pixels =
            (numeric / 100) * Math.max(window.innerWidth, window.innerHeight);
          break;
        case "rem": {
          const rootFontSize =
            parseFloat(getComputedStyle(document.documentElement).fontSize) ||
            16;
          pixels = numeric * rootFontSize;
          break;
        }
        case "em": {
          let fontSize = 16;
          if (element) {
            const style = getComputedStyle(element);
            fontSize = parseFloat(style.fontSize) || fontSize;
          } else {
            fontSize =
              parseFloat(getComputedStyle(document.documentElement).fontSize) ||
              fontSize;
          }
          pixels = numeric * fontSize;
          break;
        }
        default:
          break;
      }

      return pixels / 2;
    }
  }

  /* --------------------------------------------------
   *  Universal Element to Canvas Converter
   * ------------------------------------------------*/
  async function elementToCanvas(element, options = {}) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    let canvasWidth, canvasHeight;
    const tagName = element.tagName.toLowerCase();
    const MAX_SIDE = 2048;

    canvas.style.backgroundColor = "transparent";

    if (["img", "svg", "canvas", "video"].includes(tagName)) {
      let intrinsicW = 0;
      let intrinsicH = 0;

      if (tagName === "img") {
        intrinsicW = element.naturalWidth || 0;
        intrinsicH = element.naturalHeight || 0;
      } else if (tagName === "video") {
        intrinsicW = element.videoWidth || 0;
        intrinsicH = element.videoHeight || 0;
      } else if (tagName === "canvas") {
        intrinsicW = element.width || 0;
        intrinsicH = element.height || 0;
      } else if (tagName === "svg") {
        const viewBox = element.getAttribute("viewBox");
        if (viewBox) {
          const vb = viewBox.split(/[ ,]+/).map(Number);
          if (vb.length === 4) {
            intrinsicW = vb[2];
            intrinsicH = vb[3];
          }
        }
      }

      if (!intrinsicW || !intrinsicH) {
        const rect = element.getBoundingClientRect();
        intrinsicW = rect.width;
        intrinsicH = rect.height;
      }

      const rect = element.getBoundingClientRect();
      const containerAspect = rect.width / rect.height;

      if (tagName === "img" || tagName === "video") {
        if (containerAspect >= 1) {
          canvasWidth = MAX_SIDE;
          canvasHeight = Math.round(MAX_SIDE / containerAspect);
        } else {
          canvasHeight = MAX_SIDE;
          canvasWidth = Math.round(MAX_SIDE * containerAspect);
        }
      } else {
        const aspect = intrinsicW / intrinsicH || 1;
        if (aspect >= 1) {
          canvasWidth = MAX_SIDE;
          canvasHeight = Math.round(MAX_SIDE / aspect);
        } else {
          canvasHeight = MAX_SIDE;
          canvasWidth = Math.round(MAX_SIDE * aspect);
        }
      }
    } else {
      const rect = element.getBoundingClientRect();
      const scale = 2;
      canvasWidth = Math.min(MAX_SIDE, Math.round(rect.width * scale));
      canvasHeight = Math.min(MAX_SIDE, Math.round(rect.height * scale));
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    try {
      switch (element.tagName.toLowerCase()) {
        case "img":
          await new Promise((resolve, reject) => {
            const drawImageWithObjectFit = () => {
              const computedStyle = window.getComputedStyle(element);
              const objectFit = computedStyle.objectFit || "fill";
              const objectPosition =
                computedStyle.objectPosition || "center center";

              const naturalWidth = element.naturalWidth;
              const naturalHeight = element.naturalHeight;

              if (objectFit === "fill") {
                ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
              } else {
                const naturalAspect = naturalWidth / naturalHeight;
                const canvasAspect = canvasWidth / canvasHeight;

                let sx = 0,
                  sy = 0,
                  sw = naturalWidth,
                  sh = naturalHeight;
                let dx = 0,
                  dy = 0,
                  dw = canvasWidth,
                  dh = canvasHeight;

                if (objectFit === "contain") {
                  if (naturalAspect > canvasAspect) {
                    dh = canvasWidth / naturalAspect;
                    dy = (canvasHeight - dh) / 2;
                  } else {
                    dw = canvasHeight * naturalAspect;
                    dx = (canvasWidth - dw) / 2;
                  }
                } else if (objectFit === "cover") {
                  if (naturalAspect > canvasAspect) {
                    const scale = canvasHeight / naturalHeight;
                    const scaledWidth = naturalWidth * scale;
                    sw = canvasWidth / scale;
                    sx = (naturalWidth - sw) / 2;
                  } else {
                    const scale = canvasWidth / naturalWidth;
                    const scaledHeight = naturalHeight * scale;
                    sh = canvasHeight / scale;
                    sy = (naturalHeight - sh) / 2;
                  }
                } else if (objectFit === "none") {
                  sw = Math.min(naturalWidth, canvasWidth);
                  sh = Math.min(naturalHeight, canvasHeight);
                  sx = (naturalWidth - sw) / 2;
                  sy = (naturalHeight - sh) / 2;
                  dw = sw;
                  dh = sh;
                  dx = (canvasWidth - dw) / 2;
                  dy = (canvasHeight - dh) / 2;
                } else if (objectFit === "scale-down") {
                  const noneScale = Math.min(
                    canvasWidth / naturalWidth,
                    canvasHeight / naturalHeight,
                    1
                  );
                  if (noneScale >= 1) {
                    dw = naturalWidth;
                    dh = naturalHeight;
                    dx = (canvasWidth - dw) / 2;
                    dy = (canvasHeight - dh) / 2;
                  } else {
                    if (naturalAspect > canvasAspect) {
                      dh = canvasWidth / naturalAspect;
                      dy = (canvasHeight - dh) / 2;
                    } else {
                      dw = canvasHeight * naturalAspect;
                      dx = (canvasWidth - dw) / 2;
                    }
                  }
                }

                const positionParts = objectPosition.split(" ");
                const xPos = positionParts[0] || "center";
                const yPos = positionParts[1] || "center";

                if (objectFit === "cover") {
                  if (xPos === "left") sx = 0;
                  else if (xPos === "right") sx = naturalWidth - sw;
                  else if (xPos.includes("%")) {
                    const percent = parseFloat(xPos) / 100;
                    sx = (naturalWidth - sw) * percent;
                  }

                  if (yPos === "top") sy = 0;
                  else if (yPos === "bottom") sy = naturalHeight - sh;
                  else if (yPos.includes("%")) {
                    const percent = parseFloat(yPos) / 100;
                    sy = (naturalHeight - sh) * percent;
                  }
                } else if (
                  objectFit === "contain" ||
                  objectFit === "none" ||
                  objectFit === "scale-down"
                ) {
                  if (xPos === "left") dx = 0;
                  else if (xPos === "right") dx = canvasWidth - dw;
                  else if (xPos.includes("%")) {
                    const percent = parseFloat(xPos) / 100;
                    dx = (canvasWidth - dw) * percent;
                  }

                  if (yPos === "top") dy = 0;
                  else if (yPos === "bottom") dy = canvasHeight - dh;
                  else if (yPos.includes("%")) {
                    const percent = parseFloat(yPos) / 100;
                    dy = (canvasHeight - dh) * percent;
                  }
                }

                ctx.drawImage(element, sx, sy, sw, sh, dx, dy, dw, dh);
              }
            };

            if (element.complete) {
              drawImageWithObjectFit();
              resolve();
            } else {
              element.onload = () => {
                drawImageWithObjectFit();
                resolve();
              };
              element.onerror = reject;
            }
          });
          break;

        case "svg":
          const svgData = new XMLSerializer().serializeToString(element);
          const svgBlob = new Blob([svgData], { type: "image/svg+xml" });
          const svgUrl = URL.createObjectURL(svgBlob);
          const img = new Image();

          await new Promise((resolve, reject) => {
            img.onload = () => {
              ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
              URL.revokeObjectURL(svgUrl);
              resolve();
            };
            img.onerror = reject;
            img.src = svgUrl;
          });
          break;

        case "canvas":
          ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
          break;

        case "video":
          if (element.readyState >= 2) {
            ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
          } else {
            await new Promise((resolve) => {
              element.addEventListener(
                "loadeddata",
                () => {
                  ctx.drawImage(element, 0, 0, canvasWidth, canvasHeight);
                  resolve();
                },
                { once: true }
              );
            });
          }
          break;

        default:
          const computedStyle = window.getComputedStyle(element);

          const text = element.textContent || element.innerText;
          if (text && text.trim()) {
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);

            const originalFontSize = parseFloat(computedStyle.fontSize);
            const fontFamily = computedStyle.fontFamily || "Arial";
            const fontWeight = computedStyle.fontWeight || "normal";
            const fontStyle = computedStyle.fontStyle || "normal";
            const color = computedStyle.color || "#ffffff";
            const lineHeight =
              parseFloat(computedStyle.lineHeight) || originalFontSize * 1.2;

            const rect = element.getBoundingClientRect();
            const fontScale = Math.min(
              canvasWidth / rect.width,
              canvasHeight / rect.height
            );
            const canvasFontSize = originalFontSize * fontScale;
            const canvasLineHeight = lineHeight * fontScale;

            ctx.font = `${fontStyle} ${fontWeight} ${canvasFontSize}px ${fontFamily}`;
            ctx.fillStyle = color;
            ctx.textBaseline = "top";

            const textAlign = computedStyle.textAlign || "center";
            const words = text.split(/\s+/);
            const lines = [];
            let currentLine = "";

            const maxWidth = canvasWidth * 0.9;

            for (let word of words) {
              const testLine = currentLine + (currentLine ? " " : "") + word;
              const testWidth = ctx.measureText(testLine).width;

              if (testWidth > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
              } else {
                currentLine = testLine;
              }
            }
            if (currentLine) {
              lines.push(currentLine);
            }

            const totalTextHeight = lines.length * canvasLineHeight;
            let startY = (canvasHeight - totalTextHeight) / 2;

            lines.forEach((line, index) => {
              let x = 0;

              if (textAlign === "center" || textAlign === "justify") {
                x = canvasWidth / 2;
                ctx.textAlign = "center";
              } else if (textAlign === "right") {
                x = canvasWidth - canvasWidth * 0.05;
                ctx.textAlign = "right";
              } else {
                x = canvasWidth * 0.05;
                ctx.textAlign = "left";
              }

              const y = startY + index * canvasLineHeight;
              ctx.fillText(line, x, y);
            });
          }
          break;
      }
    } catch (error) {
      console.error("Error converting element to canvas:", error);
      ctx.fillStyle = "#333333";
      ctx.fillRect(
        canvasWidth / 4,
        canvasHeight / 4,
        canvasWidth / 2,
        canvasHeight / 2
      );
    }

    return canvas;
  }

  /* --------------------------------------------------
   *  DOM Analysis Helper
   * ------------------------------------------------*/
  function getStackingProperties(element) {
    let zIndex = 0;
    let isFixed = false;
    let el = element;

    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const currentPosition = style.position;
      const currentZIndex = parseInt(style.zIndex, 10);

      if (currentPosition === "fixed") {
        isFixed = true;
      }

      if (currentPosition !== "static" && !isNaN(currentZIndex)) {
        zIndex = Math.max(zIndex, currentZIndex);
      }

      el = el.parentElement;
    }

    const style = window.getComputedStyle(element);
    const elementZIndex = parseInt(style.zIndex, 10);
    if (style.position !== "static" && !isNaN(elementZIndex)) {
      zIndex = Math.max(zIndex, elementZIndex);
    }

    return {
      position: isFixed ? "fixed" : "absolute",
      zIndex: zIndex,
      isFixedContext: isFixed,
    };
  }

  /* --------------------------------------------------
   *  Instance Management
   * ------------------------------------------------*/
  class GlitchGLInstance {
    constructor(options, elements) {
      this.id = `glitch-gl-${++instanceCounter}`;
      this.options = options;
      this.elements = elements;
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return;

      if (!globalRenderer) {
        globalRenderer = new GlitchGLRenderer();
        globalRenderer.startAnimation();
        setupGlobalResizeObserver();
      }

      for (let i = 0; i < this.elements.length; i++) {
        const element = this.elements[i];
        try {
          const elementId = element.id || `element-${i}`;
          globalRenderer.addGlitchSystem(
            this.id + "-" + elementId,
            element,
            this.options
          );
        } catch (error) {
          console.error(
            "glitchGL: Failed to create glitch system for element:",
            element,
            error
          );
        }
      }

      this.initialized = true;
      activeInstances.set(this.id, this);

      if (this.options.on && this.options.on.init) {
        this.options.on.init(this);
      }
    }

    cleanup(keepTargetHidden = false) {
      if (!this.initialized) return;

      for (let i = 0; i < this.elements.length; i++) {
        const element = this.elements[i];
        const elementId = element.id || `element-${i}`;
        globalRenderer.removeGlitchSystem(
          this.id + "-" + elementId,
          keepTargetHidden
        );
      }

      activeInstances.delete(this.id);

      if (activeInstances.size === 0 && globalRenderer) {
        globalRenderer.dispose();
        globalRenderer = null;
        cleanupGlobalResizeObserver();
      }

      this.initialized = false;
    }

    async reloadInteractionTexture() {
      if (!globalRenderer) return;
      for (let i = 0; i < this.elements.length; i++) {
        const element = this.elements[i];
        const elementId = element.id || `element-${i}`;
        const instanceId = this.id + "-" + elementId;
        const systemData = globalRenderer.glitchSystems.get(instanceId);

        if (systemData && systemData.glitchMaterial) {
          const interactionConfig = globalRenderer.getInteractionOptions(
            this.options
          );
          if (
            interactionConfig &&
            interactionConfig.shape === "custom" &&
            interactionConfig.customUrl
          ) {
            const textures = await globalRenderer.loadCustomInteractionTexture(
              interactionConfig.customUrl
            );

            const oldTexture =
              systemData.glitchMaterial.uniforms.interactionTexture.value;
            if (oldTexture && oldTexture.dispose) {
              oldTexture.dispose();
            }
            const oldGradient =
              systemData.glitchMaterial.uniforms.interactionGradientTexture
                .value;
            if (oldGradient && oldGradient.dispose) {
              oldGradient.dispose();
            }

            if (textures) {
              systemData.glitchMaterial.uniforms.interactionTexture.value =
                textures.texture || null;
              systemData.glitchMaterial.uniforms.interactionGradientTexture.value =
                textures.gradientTexture || null;
              systemData.glitchMaterial.uniforms.hasCustomInteractionTexture.value =
                !!(textures.texture && textures.gradientTexture);
            } else {
              systemData.glitchMaterial.uniforms.interactionTexture.value =
                null;
              systemData.glitchMaterial.uniforms.interactionGradientTexture.value =
                null;
              systemData.glitchMaterial.uniforms.hasCustomInteractionTexture.value = false;
            }

            const shapeValue =
              globalRenderer.getInteractionShapeValue("custom");
            systemData.glitchMaterial.uniforms.interactionShape.value =
              shapeValue;

            if (textures && textures.texture) {
              const canvas = textures.texture.image;
              const newCanvasTexture = new THREE.CanvasTexture(canvas);
              newCanvasTexture.minFilter = THREE.LinearFilter;
              newCanvasTexture.magFilter = THREE.LinearFilter;
              newCanvasTexture.format = THREE.RGBAFormat;
              newCanvasTexture.needsUpdate = true;

              systemData.glitchMaterial.uniforms.interactionTexture.value =
                newCanvasTexture;
            }
            if (textures && textures.texture?.image) {
              const canvas = textures.texture.image;
              const ctx = canvas.getContext("2d");
              const testData = ctx.getImageData(256, 256, 1, 1);
            }

            let aspect = 1.0;
            if (
              textures &&
              textures.texture &&
              textures.texture.image &&
              textures.texture.image.width &&
              textures.texture.image.height > 0
            ) {
              aspect =
                textures.texture.image.width / textures.texture.image.height;
            }
            systemData.glitchMaterial.uniforms.interactionTextureAspect.value =
              aspect;
          } else if (
            interactionConfig &&
            interactionConfig.shape !== "custom"
          ) {
            const oldTexture =
              systemData.glitchMaterial.uniforms.interactionTexture.value;
            if (oldTexture && oldTexture.dispose) {
              oldTexture.dispose();
            }
            systemData.glitchMaterial.uniforms.interactionTexture.value = null;
            systemData.glitchMaterial.uniforms.hasCustomInteractionTexture.value = false;
          }
        }
      }
    }

    hasCustomTextureLoaded() {
      if (!globalRenderer) return false;

      for (let i = 0; i < this.elements.length; i++) {
        const element = this.elements[i];
        const elementId = element.id || `element-${i}`;
        const instanceId = this.id + "-" + elementId;
        const systemData = globalRenderer.glitchSystems.get(instanceId);

        if (
          systemData?.glitchMaterial?.uniforms?.hasCustomInteractionTexture
            ?.value
        ) {
          return true;
        }
      }
      return false;
    }

    didInteractionTextureChange(oldOptions, currentOptions) {
      const oldInteraction = oldOptions.interaction;
      const newInteraction = currentOptions.interaction;
      if (oldInteraction && newInteraction) {
        if (newInteraction.customUrl !== oldInteraction.customUrl) {
          return true;
        }

        if (
          newInteraction.shape === "custom" &&
          oldInteraction.shape !== "custom"
        ) {
          return true;
        }

        if (
          newInteraction.shape !== "custom" &&
          oldInteraction.shape === "custom"
        ) {
          return true;
        }
      }
      return false;
    }

    async updateOptions(newOptions) {
      const oldOptions = JSON.parse(JSON.stringify(this.options));
      this.options = this.mergeDeep(this.options, newOptions);

      const textureChanged = this.didInteractionTextureChange(
        oldOptions,
        this.options
      );

      const needsCustomTexture =
        this.options.interaction?.shape === "custom" &&
        this.options.interaction?.customUrl &&
        !this.hasCustomTextureLoaded();
      if (textureChanged || needsCustomTexture) {
        await this.reloadInteractionTexture();
      }

      for (const [instanceId, systemData] of globalRenderer.glitchSystems) {
        if (this.elements.includes(systemData.element)) {
          const newRadiusPx = globalRenderer.getInteractionRadiusPx(
            this.options,
            systemData.element
          );
          if (systemData.radiusPx !== newRadiusPx) {
            systemData.radiusPx = newRadiusPx;
            if (systemData.glitchMaterial) {
              systemData.glitchMaterial.uniforms.radiusPx.value = newRadiusPx;
            }
          }
        }
      }

      this.updateShaderUniforms(newOptions);
    }

    updateShaderUniforms(newOptions) {
      if (!globalRenderer) return;

      for (let i = 0; i < this.elements.length; i++) {
        const element = this.elements[i];
        const elementId = element.id || `element-${i}`;
        const instanceId = this.id + "-" + elementId;
        const systemData = globalRenderer.glitchSystems.get(instanceId);

        if (systemData && systemData.glitchMaterial) {
          const materialsToUpdate = [systemData.glitchMaterial].filter(Boolean);

          for (const material of materialsToUpdate) {
            if (!material) continue;

            const uniforms = material.uniforms;

            const safeUpdate = (uniformName, value) => {
              if (uniforms[uniformName]) {
                uniforms[uniformName].value = value;
              }
            };

            if (newOptions.intensity !== undefined) {
              safeUpdate("intensity", newOptions.intensity);
            }

            if (newOptions.effects) {
              if (
                newOptions.effects.pixelation &&
                newOptions.effects.pixelation.enabled !== undefined
              ) {
                safeUpdate(
                  "pixelationEnabled",
                  newOptions.effects.pixelation.enabled
                );
              }
              if (
                newOptions.effects.crt &&
                newOptions.effects.crt.enabled !== undefined
              ) {
                safeUpdate("crtEnabled", newOptions.effects.crt.enabled);
              }
              if (
                newOptions.effects.glitch &&
                newOptions.effects.glitch.enabled !== undefined
              ) {
                safeUpdate("glitchEnabled", newOptions.effects.glitch.enabled);
              }
            }

            if (newOptions.interaction) {
              const interaction = newOptions.interaction;
              if (interaction.enabled !== undefined) {
                safeUpdate("interactionEnabled", interaction.enabled);
              }
              if (interaction.shape !== undefined) {
                const shapeValue = globalRenderer.getInteractionShapeValue(
                  interaction.shape
                );
                safeUpdate("interactionShape", shapeValue);
              }

              if (interaction.effects !== undefined) {
                if (interaction.effects.pixelation !== undefined) {
                  safeUpdate(
                    "pixelSizeInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "pixelation",
                      "pixelSize"
                    )
                  );
                }

                if (interaction.effects.crt !== undefined) {
                  safeUpdate(
                    "chromaticAberrationInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "crt",
                      "chromaticAberration"
                    )
                  );
                  safeUpdate(
                    "scanlinesInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "crt",
                      "scanlines"
                    )
                  );
                  safeUpdate(
                    "phosphorGlowInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "crt",
                      "phosphorGlow"
                    )
                  );
                  safeUpdate(
                    "curvatureInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "crt",
                      "curvature"
                    )
                  );
                }

                if (interaction.effects.glitch !== undefined) {
                  safeUpdate(
                    "rgbShiftInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "rgbShift"
                    )
                  );
                  safeUpdate(
                    "digitalNoiseInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "digitalNoise"
                    )
                  );
                  safeUpdate(
                    "lineDisplacementInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "lineDisplacement"
                    )
                  );
                  safeUpdate(
                    "bitCrushInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "bitCrushing"
                    )
                  );
                  safeUpdate(
                    "signalDropoutInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "signalDropout"
                    )
                  );
                  safeUpdate(
                    "syncErrorsInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "syncErrors"
                    )
                  );
                  safeUpdate(
                    "interferenceLinesInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "interferenceLines"
                    )
                  );
                  safeUpdate(
                    "frameGhostingInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "frameGhosting"
                    )
                  );
                  safeUpdate(
                    "stutterFreezeInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "stutterFreeze"
                    )
                  );
                  safeUpdate(
                    "datamoshingInteractive",
                    globalRenderer.isEffectInteractive(
                      this.options,
                      "glitch",
                      "datamoshing"
                    )
                  );
                }
              }
            }

            if (newOptions.effects) {
              if (newOptions.effects.pixelation) {
                const opts = newOptions.effects.pixelation;
                if (opts.pixelSize !== undefined)
                  safeUpdate("pixelSize", opts.pixelSize);
                if (opts.pixelShape !== undefined)
                  safeUpdate(
                    "pixelShape",
                    globalRenderer.getPixelShapeValue(opts.pixelShape)
                  );
                if (opts.bitDepth !== undefined)
                  safeUpdate(
                    "bitDepth",
                    globalRenderer.getBitDepthValue(opts.bitDepth)
                  );
                if (opts.dithering !== undefined)
                  safeUpdate(
                    "dithering",
                    globalRenderer.getDitheringValue(opts.dithering)
                  );
                if (opts.pixelDirection !== undefined)
                  safeUpdate(
                    "pixelDirection",
                    globalRenderer.getPixelDirectionValue(opts.pixelDirection)
                  );
              }

              if (newOptions.effects.crt) {
                const opts = newOptions.effects.crt;
                if (opts.scanlineIntensity !== undefined)
                  safeUpdate("scanlineIntensity", opts.scanlineIntensity);
                if (opts.phosphorGlow !== undefined)
                  safeUpdate("phosphorGlow", opts.phosphorGlow);
                if (opts.curvature !== undefined)
                  safeUpdate("curvature", opts.curvature);
                if (opts.chromaticAberration !== undefined)
                  safeUpdate("chromaticAberration", opts.chromaticAberration);
                if (opts.scanlineThickness !== undefined)
                  safeUpdate("scanlineThickness", opts.scanlineThickness);
                if (opts.scanlineCount !== undefined)
                  safeUpdate("scanlineCount", opts.scanlineCount);
                if (opts.brightness !== undefined)
                  safeUpdate("brightness", opts.brightness);
                if (opts.flicker !== undefined)
                  safeUpdate("flicker", opts.flicker);
                if (opts.flickerIntensity !== undefined)
                  safeUpdate("flickerIntensity", opts.flickerIntensity);
                if (opts.lineMovement !== undefined)
                  safeUpdate("lineMovement", opts.lineMovement);
                if (opts.lineSpeed !== undefined)
                  safeUpdate("lineSpeed", opts.lineSpeed);
                if (opts.lineDirection !== undefined)
                  safeUpdate(
                    "lineDirection",
                    globalRenderer.getLineDirectionValue(opts.lineDirection)
                  );
              }

              if (newOptions.effects.glitch) {
                const opts = newOptions.effects.glitch;
                if (opts.rgbShift !== undefined)
                  safeUpdate("rgbShift", opts.rgbShift);
                if (opts.digitalNoise !== undefined)
                  safeUpdate("digitalNoise", opts.digitalNoise);
                if (opts.lineDisplacement !== undefined)
                  safeUpdate("lineDisplacement", opts.lineDisplacement);
                if (opts.bitCrushDepth !== undefined)
                  safeUpdate("bitCrushDepth", opts.bitCrushDepth);
                if (opts.signalDropoutFreq !== undefined)
                  safeUpdate("signalDropoutFreq", opts.signalDropoutFreq);
                if (opts.signalDropoutSize !== undefined)
                  safeUpdate("signalDropoutSize", opts.signalDropoutSize);
                if (opts.syncErrorFreq !== undefined)
                  safeUpdate("syncErrorFreq", opts.syncErrorFreq);
                if (opts.syncErrorAmount !== undefined)
                  safeUpdate("syncErrorAmount", opts.syncErrorAmount);
                if (opts.interferenceSpeed !== undefined)
                  safeUpdate("interferenceSpeed", opts.interferenceSpeed);
                if (opts.interferenceIntensity !== undefined)
                  safeUpdate(
                    "interferenceIntensity",
                    opts.interferenceIntensity
                  );
                if (opts.frameGhostAmount !== undefined)
                  safeUpdate("frameGhostAmount", opts.frameGhostAmount);
                if (opts.stutterFreq !== undefined)
                  safeUpdate("stutterFreq", opts.stutterFreq);
                if (opts.datamoshStrength !== undefined)
                  safeUpdate("datamoshStrength", opts.datamoshStrength);
              }
            }
          }
        }
      }

      if (globalRenderer) {
        globalRenderer.triggerRenderAll();
      }
    }

    mergeDeep(target, source) {
      const output = Object.assign({}, target);
      if (this.isObject(target) && this.isObject(source)) {
        Object.keys(source).forEach((key) => {
          if (this.isObject(source[key])) {
            if (!(key in target)) Object.assign(output, { [key]: source[key] });
            else output[key] = this.mergeDeep(target[key], source[key]);
          } else {
            Object.assign(output, { [key]: source[key] });
          }
        });
      }
      return output;
    }

    isObject(item) {
      return !!(item && typeof item === "object" && !Array.isArray(item));
    }
  }

  /* --------------------------------------------------
   *  Global Resize Observer
   * ------------------------------------------------*/
  function setupGlobalResizeObserver() {
    if (resizeObserver) return;

    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    let lastDevicePixelRatio = window.devicePixelRatio;

    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      ) ||
      ("ontouchstart" in window && window.innerWidth < 1024);

    const handleResize = () => {
      if (resizeDebounceTimer) {
        clearTimeout(resizeDebounceTimer);
      }

      resizeDebounceTimer = setTimeout(() => {
        const currentWidth = window.innerWidth;
        const currentHeight = window.innerHeight;
        const currentDevicePixelRatio = window.devicePixelRatio;

        const widthChanged = Math.abs(currentWidth - lastWidth) > 10;
        const heightChanged = isMobile
          ? false
          : Math.abs(currentHeight - lastHeight) > 100;
        const pixelRatioChanged =
          currentDevicePixelRatio !== lastDevicePixelRatio;

        if (widthChanged || heightChanged || pixelRatioChanged) {
          lastWidth = currentWidth;
          lastHeight = currentHeight;
          lastDevicePixelRatio = currentDevicePixelRatio;

          if (globalRenderer) {
            globalRenderer.triggerRenderAll();
          }
        }
      }, 250);
    };

    const handleOrientationChange = () => {
      if (isMobile) {
        setTimeout(() => {
          handleResize();
        }, 500);
      }
    };

    window.addEventListener("resize", handleResize);

    if (isMobile) {
      window.addEventListener("orientationchange", handleOrientationChange);
    }

    resizeObserver = { handleResize, handleOrientationChange, isMobile };
  }

  function cleanupGlobalResizeObserver() {
    if (resizeObserver) {
      window.removeEventListener("resize", resizeObserver.handleResize);

      if (resizeObserver.isMobile) {
        window.removeEventListener(
          "orientationchange",
          resizeObserver.handleOrientationChange
        );
      }

      resizeObserver = null;
    }

    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = null;
    }
  }

  /* --------------------------------------------------
   *  Preset Definitions
   * ------------------------------------------------*/
  const crtPresets = {
    "consumer-tv": {
      scanlineIntensity: 0.7,
      scanlineThickness: 0.8,
      scanlineCount: 240,
      brightness: 1.2,
      phosphorGlow: 0.4,
      curvature: 8.0,
      chromaticAberration: 0.004,
      flicker: false,
      flickerIntensity: 0.5,
      lineMovement: false,
      lineSpeed: 1.0,
      lineDirection: "up",
    },
    "arcade-monitor": {
      scanlineIntensity: 0.5,
      scanlineThickness: 0.6,
      scanlineCount: 240,
      brightness: 1.4,
      phosphorGlow: 0.6,
      curvature: 4.0,
      chromaticAberration: 0.002,
      flicker: true,
      flickerIntensity: 0.5,
      lineMovement: false,
      lineSpeed: 1.0,
      lineDirection: "up",
    },
    "computer-monitor": {
      scanlineIntensity: 0.3,
      scanlineThickness: 0.4,
      scanlineCount: 480,
      brightness: 1.1,
      phosphorGlow: 0.2,
      curvature: 2.0,
      chromaticAberration: 0.001,
      flicker: false,
      flickerIntensity: 0.5,
      lineMovement: false,
      lineSpeed: 1.0,
      lineDirection: "up",
    },
    "broadcast-monitor": {
      scanlineIntensity: 0.2,
      scanlineThickness: 0.3,
      scanlineCount: 720,
      brightness: 4.0,
      phosphorGlow: 0.1,
      curvature: 11.6,
      chromaticAberration: 0.0045,
      flicker: true,
      flickerIntensity: 0.5,
      lineMovement: false,
      lineSpeed: 1.0,
      lineDirection: "up",
    },
  };

  /* --------------------------------------------------
   *  Public API
   * ------------------------------------------------*/
  window.glitchGL = function (userOptions = {}) {
    const defaultCRTPreset = crtPresets["consumer-tv"];

    const defaults = {
      target: ".glitchGL",
      intensity: 1.0,
      aspectCorrection: true,
      modelScale: 1,
      tiltFactor: 0.2,
      tiltSpeed: 0.05,
      interaction: {
        enabled: true,
        shape: "circle",
        customSize: "10vw",
        customUrl: null,
        velocity: false,
        effects: {
          pixelation: [],
          crt: [],
          glitch: [],
        },
      },
      effects: {
        pixelation: {
          enabled: true,
          pixelSize: 8,
          pixelShape: "square",
          bitDepth: "none",
          dithering: "none",
          pixelDirection: "square",
        },
        crt: {
          enabled: false,
          preset: "consumer-tv",
          ...defaultCRTPreset,
        },
        glitch: {
          enabled: false,
          rgbShift: 0,
          digitalNoise: 0.1,
          lineDisplacement: 0.01,
          bitCrushDepth: 4.0,
          signalDropoutFreq: 0.05,
          signalDropoutSize: 0.1,
          syncErrorFreq: 0.02,
          syncErrorAmount: 0.05,
          interferenceSpeed: 1.0,
          interferenceIntensity: 0.2,
          frameGhostAmount: 0.3,
          stutterFreq: 0.1,
          datamoshStrength: 0.5,
        },
      },
      on: {},
    };

    if (
      userOptions &&
      userOptions.effects?.crt?.preset &&
      crtPresets[userOptions.effects.crt.preset]
    ) {
      const presetValues = crtPresets[userOptions.effects.crt.preset];
      userOptions.effects.crt = {
        ...presetValues,
        ...userOptions.effects.crt,
      };
    }

    const options = window.glitchGL.mergeDeep(defaults, userOptions);

    const elements = document.querySelectorAll(options.target);
    if (elements.length === 0) {
      console.error(
        `glitchGL: No elements found with selector "${options.target}"`
      );
      return null;
    }

    const instance = new GlitchGLInstance(options, Array.from(elements));
    instance.init();

    return {
      init: () => instance.init(),
      cleanup: () => instance.cleanup(),
      updateOptions: (newOptions) => instance.updateOptions(newOptions),
      get options() {
        return instance.options;
      },

      setIntensity: (value) => instance.updateOptions({ intensity: value }),
      setInteractionRadius: (value) => {
        instance.updateOptions({
          interaction: { customSize: value },
        });
      },

      setPixelSize: (value) =>
        instance.updateOptions({
          effects: { pixelation: { pixelSize: value } },
        }),
      setPixelShape: (value) =>
        instance.updateOptions({
          effects: { pixelation: { pixelShape: value } },
        }),
      setBitDepth: (value) =>
        instance.updateOptions({
          effects: { pixelation: { bitDepth: value } },
        }),
      setDithering: (value) =>
        instance.updateOptions({
          effects: { pixelation: { dithering: value } },
        }),
      setPixelDirection: (value) =>
        instance.updateOptions({
          effects: { pixelation: { pixelDirection: value } },
        }),
      setPixelationInteraction: (effects) =>
        instance.updateOptions({
          interaction: { effects: { pixelation: effects } },
        }),
      setPixelationInteractionShape: (shape, customUrl = null, customSize) => {
        const updates = { shape };
        if (customUrl !== null) updates.customUrl = customUrl;
        if (customSize !== undefined) updates.customSize = customSize;
        instance.updateOptions({
          interaction: updates,
        });
      },

      setScanlineIntensity: (value) =>
        instance.updateOptions({
          effects: { crt: { scanlineIntensity: value } },
        }),
      setPhosphorGlow: (value) =>
        instance.updateOptions({ effects: { crt: { phosphorGlow: value } } }),
      setCurvature: (value) =>
        instance.updateOptions({ effects: { crt: { curvature: value } } }),
      setChromaticAberration: (value) =>
        instance.updateOptions({
          effects: { crt: { chromaticAberration: value } },
        }),
      setScanlineThickness: (value) =>
        instance.updateOptions({
          effects: { crt: { scanlineThickness: value } },
        }),
      setScanlineCount: (value) =>
        instance.updateOptions({ effects: { crt: { scanlineCount: value } } }),
      setBrightness: (value) =>
        instance.updateOptions({ effects: { crt: { brightness: value } } }),
      setFlicker: (value) =>
        instance.updateOptions({ effects: { crt: { flicker: value } } }),
      setFlickerIntensity: (value) =>
        instance.updateOptions({
          effects: { crt: { flickerIntensity: value } },
        }),
      setLineMovement: (value) =>
        instance.updateOptions({ effects: { crt: { lineMovement: value } } }),
      setLineSpeed: (value) =>
        instance.updateOptions({ effects: { crt: { lineSpeed: value } } }),
      setLineDirection: (value) =>
        instance.updateOptions({ effects: { crt: { lineDirection: value } } }),
      setCRTInteraction: (effects) =>
        instance.updateOptions({
          interaction: { effects: { crt: effects } },
        }),
      setCRTInteractionShape: (shape, customUrl = null, customSize) => {
        const updates = { shape };
        if (customUrl !== null) updates.customUrl = customUrl;
        if (customSize !== undefined) updates.customSize = customSize;
        instance.updateOptions({
          interaction: updates,
        });
      },

      setCRTPreset: (preset) => {
        if (crtPresets[preset]) {
          instance.updateOptions({
            effects: { crt: { ...crtPresets[preset], preset: preset } },
          });
        } else {
          console.warn(
            `glitchGL: Unknown CRT preset "${preset}". Available presets: ${Object.keys(
              crtPresets
            ).join(", ")}`
          );
        }
      },

      setRgbShift: (value) =>
        instance.updateOptions({ effects: { glitch: { rgbShift: value } } }),
      setDigitalNoise: (value) =>
        instance.updateOptions({
          effects: { glitch: { digitalNoise: value } },
        }),
      setLineDisplacement: (value) =>
        instance.updateOptions({
          effects: { glitch: { lineDisplacement: value } },
        }),

      setBitCrushDepth: (value) =>
        instance.updateOptions({
          effects: { glitch: { bitCrushDepth: value } },
        }),

      setSignalDropoutFreq: (value) =>
        instance.updateOptions({
          effects: { glitch: { signalDropoutFreq: value } },
        }),
      setSignalDropoutSize: (value) =>
        instance.updateOptions({
          effects: { glitch: { signalDropoutSize: value } },
        }),
      setSyncErrorFreq: (value) =>
        instance.updateOptions({
          effects: { glitch: { syncErrorFreq: value } },
        }),
      setSyncErrorAmount: (value) =>
        instance.updateOptions({
          effects: { glitch: { syncErrorAmount: value } },
        }),
      setInterferenceSpeed: (value) =>
        instance.updateOptions({
          effects: { glitch: { interferenceSpeed: value } },
        }),
      setInterferenceIntensity: (value) =>
        instance.updateOptions({
          effects: { glitch: { interferenceIntensity: value } },
        }),
      setFrameGhostAmount: (value) =>
        instance.updateOptions({
          effects: { glitch: { frameGhostAmount: value } },
        }),
      setStutterFreq: (value) =>
        instance.updateOptions({ effects: { glitch: { stutterFreq: value } } }),
      setDatamoshStrength: (value) =>
        instance.updateOptions({
          effects: { glitch: { datamoshStrength: value } },
        }),

      setGlitchInteraction: (effects) =>
        instance.updateOptions({
          interaction: { effects: { glitch: effects } },
        }),
      setGlitchInteractionShape: (shape, customUrl = null, customSize) => {
        const updates = { shape };
        if (customUrl !== null) updates.customUrl = customUrl;
        if (customSize !== undefined) updates.customSize = customSize;
        instance.updateOptions({
          interaction: updates,
        });
      },
      enableGlitchInteraction: () =>
        instance.updateOptions({
          interaction: { enabled: true },
        }),
      disableGlitchInteraction: () =>
        instance.updateOptions({
          interaction: { enabled: false },
        }),

      animate: (property, from, to, duration, easing = "linear") => {
        return new Promise((resolve) => {
          const startTime = performance.now();
          const startValue = from;
          const endValue = to;
          const range = endValue - startValue;

          const easingFunctions = {
            linear: (t) => t,
            easeIn: (t) => t * t,
            easeOut: (t) => t * (2 - t),
            easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
          };

          const easingFunc = easingFunctions[easing] || easingFunctions.linear;

          const animate = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easedProgress = easingFunc(progress);
            const currentValue = startValue + range * easedProgress;

            if (property === "intensity") {
              instance.updateOptions({ intensity: currentValue });
            } else if (property === "interactionRadius") {
              instance.updateOptions({
                interaction: { customSize: currentValue },
              });
            } else if (property === "pixelSize") {
              instance.updateOptions({
                effects: { pixelation: { pixelSize: currentValue } },
              });
            } else if (property === "scanlineIntensity") {
              instance.updateOptions({
                effects: { crt: { scanlineIntensity: currentValue } },
              });
            } else if (property === "rgbShift") {
              instance.updateOptions({
                effects: { glitch: { rgbShift: currentValue } },
              });
            } else if (property === "bitCrushDepth") {
              instance.updateOptions({
                effects: { glitch: { bitCrushDepth: currentValue } },
              });
            } else if (property === "datamoshStrength") {
              instance.updateOptions({
                effects: { glitch: { datamoshStrength: currentValue } },
              });
            } else if (property === "interferenceIntensity") {
              instance.updateOptions({
                effects: { glitch: { interferenceIntensity: currentValue } },
              });
            }

            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              resolve();
            }
          };

          animate();
        });
      },

      enablePixelation: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: true },
          },
        }),
      enableCRT: () =>
        instance.updateOptions({
          effects: {
            crt: { enabled: true },
          },
        }),
      enableGlitch: () =>
        instance.updateOptions({
          effects: {
            glitch: { enabled: true },
          },
        }),
      disablePixelation: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: false },
          },
        }),
      disableCRT: () =>
        instance.updateOptions({
          effects: {
            crt: { enabled: false },
          },
        }),
      disableGlitch: () =>
        instance.updateOptions({
          effects: {
            glitch: { enabled: false },
          },
        }),
      disableAll: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: false },
            crt: { enabled: false },
            glitch: { enabled: false },
          },
        }),

      enableOnlyPixelation: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: true },
            crt: { enabled: false },
            glitch: { enabled: false },
          },
        }),
      enableOnlyCRT: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: false },
            crt: { enabled: true },
            glitch: { enabled: false },
          },
        }),
      enableOnlyGlitch: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: false },
            crt: { enabled: false },
            glitch: { enabled: true },
          },
        }),

      enableAllEffects: () =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: true },
            crt: { enabled: true },
            glitch: { enabled: true },
          },
        }),
      setEffectsEnabled: (pixelation, crt, glitch) =>
        instance.updateOptions({
          effects: {
            pixelation: { enabled: pixelation },
            crt: { enabled: crt },
            glitch: { enabled: glitch },
          },
        }),

      setInteractionShape: (shape, customUrl = null, customSize) => {
        const updates = { shape };
        if (customUrl !== null) updates.customUrl = customUrl;
        if (customSize !== undefined) updates.customSize = customSize;
        instance.updateOptions({
          interaction: updates,
        });
      },
      setCircleInteraction: () =>
        instance.updateOptions({
          interaction: { shape: "circle" },
        }),
      setSquareInteraction: () =>
        instance.updateOptions({
          interaction: { shape: "square" },
        }),
      setDiamondInteraction: () =>
        instance.updateOptions({
          interaction: { shape: "diamond" },
        }),
      setCrossInteraction: () =>
        instance.updateOptions({
          interaction: { shape: "cross" },
        }),
      setPlusInteraction: () =>
        instance.updateOptions({
          interaction: { shape: "plus" },
        }),
      setCustomInteraction: (svgUrl, customSize) => {
        const updates = { shape: "custom", customUrl: svgUrl };
        if (customSize !== undefined) updates.customSize = customSize;
        instance.updateOptions({
          interaction: updates,
        });
      },

      setCustomShapeSize: (size) => {
        instance.updateOptions({
          interaction: { customSize: size },
        });
      },
    };
  };

  window.glitchGL.presets = {
    crt: crtPresets,
  };

  window.glitchGL.mergeDeep = function (target, source) {
    const output = Object.assign({}, target);
    if (window.glitchGL.isObject(target) && window.glitchGL.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (window.glitchGL.isObject(source[key])) {
          if (!(key in target)) Object.assign(output, { [key]: source[key] });
          else
            output[key] = window.glitchGL.mergeDeep(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  };

  window.glitchGL.isObject = function (item) {
    return !!(item && typeof item === "object" && !Array.isArray(item));
  };
})();
