/**
 * Eye-Dome Lighting for point clouds — the edge shading ifclite.com draws.
 *
 * A scan has no normals, so nothing in it can be lit: drawn flat, a wall and
 * the floor in front of it are one colour and the shape is lost. EDL shades by
 * depth instead. Each point looks at a ring of neighbours on screen and darkens
 * by how much nearer they are than it (Potree's formula: the mean of the
 * positive log-depth differences, through `exp(-300 · strength · mean)`), so
 * every step in depth gets a dark edge. An empty pixel beside points gets a
 * halo, which outlines the cloud's silhouette.
 *
 * How it fits in a scene it does not own: the clouds are drawn alone into an
 * offscreen target that keeps their depth (`render`), then a full-screen quad in
 * the main scene (`quad`) draws them back — shaded — and writes that depth with
 * `gl_FragDepth`. The model therefore still hides a cloud behind it and is hidden
 * by one in front of it, exactly as when the points were drawn directly. The
 * renderer's depth buffer is logarithmic; the target is filled by the same
 * renderer, so the depth it holds is the same encoding the main pass compares
 * against, and the shader only has to undo it to get distances for the formula.
 *
 * Only the clouds: the model has normals and is lit, and an outline on every
 * mesh edge is the edge renderer's job (`edges.ts`).
 */

import * as THREE from "three";

/** The layer the clouds move to while EDL draws them, so the main pass skips them. */
export const POINT_CLOUD_EDL_LAYER = 5;

export type PointCloudEdlOptions = {
  /** Multiplier on the darkening. Potree's and ifc-lite's default is 1. */
  strength: number;
  /** How far, in CSS pixels, the neighbours are sampled. */
  radius: number;
};

export const DEFAULT_POINT_CLOUD_EDL: PointCloudEdlOptions = { strength: 1, radius: 1.4 };

const vertexShader = /* glsl */ `
void main() {
  // A full-screen triangle pair: no camera, it covers the viewport as it is.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tColour;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform float radius;
uniform float strength;
uniform float cameraNear;
uniform float cameraFar;
uniform bool perspective;

// log2 of the distance from the camera, from the depth the renderer wrote.
// Perspective: three's logarithmic depth is 0.5 · log2(1 + w) · (2 / log2(far + 1)),
// so log2(1 + w) is the depth times log2(far + 1). Orthographic: three writes
// plain linear depth, so the distance is recovered and its log taken.
float logDistance(float depth) {
  if (perspective) return depth * log2(cameraFar + 1.0);
  return log2(max(cameraNear + depth * (cameraFar - cameraNear), 1e-6));
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float depth = texture2D(tDepth, uv).x;
  bool point = depth < 1.0;
  float centre = point ? logDistance(depth) : 0.0;

  vec2 texel = radius / resolution;
  vec2 ring[8];
  ring[0] = vec2( 1.0,  0.0);
  ring[1] = vec2(-1.0,  0.0);
  ring[2] = vec2( 0.0,  1.0);
  ring[3] = vec2( 0.0, -1.0);
  ring[4] = vec2( 0.7071,  0.7071);
  ring[5] = vec2(-0.7071,  0.7071);
  ring[6] = vec2( 0.7071, -0.7071);
  ring[7] = vec2(-0.7071, -0.7071);

  float sum = 0.0;
  float nearest = 1.0;
  for (int i = 0; i < 8; i++) {
    float neighbour = texture2D(tDepth, uv + ring[i] * texel).x;
    // Empty neighbours say nothing about depth, as in Potree.
    if (neighbour >= 1.0) continue;
    nearest = min(nearest, neighbour);
    // An empty pixel beside points is the silhouette's halo; a point darkens by
    // how much nearer its neighbours are than it.
    sum += point ? max(0.0, centre - logDistance(neighbour)) : 100.0;
  }
  float shade = exp(-300.0 * strength * (sum / 8.0));

  if (point) {
    gl_FragColor = vec4(texture2D(tColour, uv).rgb * shade, 1.0);
    gl_FragDepth = depth;
  } else if (sum > 0.0) {
    // The halo sits at the depth of the points it outlines, so the model in
    // front of them hides it too.
    gl_FragColor = vec4(0.0, 0.0, 0.0, min(1.0 - shade, 0.85));
    gl_FragDepth = nearest;
  } else {
    discard;
  }

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class PointCloudEdl {
  /** Add to the scene once; it draws only while `quad.visible`. */
  readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private target: THREE.WebGLRenderTarget;
  private size = new THREE.Vector2();

  constructor(private options: PointCloudEdlOptions = DEFAULT_POINT_CLOUD_EDL) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      // Linear colour goes in, so 8 bits would band the dark end; half floats do not.
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tColour: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        resolution: { value: new THREE.Vector2(1, 1) },
        radius: { value: options.radius },
        strength: { value: options.strength },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 1000 },
        perspective: { value: true },
      },
      // Blended for the halo; the points themselves come out opaque.
      transparent: true,
      depthTest: true,
      depthWrite: true,
      // Section planes already clipped the points when they were drawn.
      clipping: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.quad.frustumCulled = false;
    // Where the points used to sort: behind the model at equal depth, so the
    // thing being checked wins.
    this.quad.renderOrder = -1;
    this.quad.visible = false;
  }

  setOptions(options: Partial<PointCloudEdlOptions>) {
    this.options = { ...this.options, ...options };
  }

  /**
   * Draw the objects on `POINT_CLOUD_EDL_LAYER` into the offscreen target and
   * point the quad at it. Call right before the main render, every frame the
   * clouds are shown with EDL.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, this.size.x);
    const height = Math.max(1, this.size.y);
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    const previousTarget = renderer.getRenderTarget();
    const previousMask = camera.layers.mask;
    const previousBackground = scene.background;
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();

    camera.layers.set(POINT_CLOUD_EDL_LAYER);
    // Empty where there is no point, and nothing else drawn: depth 1 means "none".
    scene.background = null;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);
    scene.background = previousBackground;
    camera.layers.mask = previousMask;

    const uniforms = this.quad.material.uniforms;
    (uniforms.resolution.value as THREE.Vector2).set(width, height);
    uniforms.radius.value = this.options.radius * renderer.getPixelRatio();
    uniforms.strength.value = this.options.strength;
    const projection = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    uniforms.cameraNear.value = projection.near;
    uniforms.cameraFar.value = projection.far;
    uniforms.perspective.value = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
