import { ExtensionType, extensions, glUploadBufferImageResource, type GLTextureUploader } from "pixi.js";

/**
 * Workaround for shadows that scramble frame to frame on Intel GPUs under Chrome/Edge's default
 * WebGL backend (ANGLE on Direct3D 11).
 *
 * Under WebGL, @pixi/3d (0.1.0) culls every shadow cascade on the CPU and rewrites the same
 * `InstanceIndex` texture (texSubImage2D) right before that cascade's draws. Intel's D3D11 driver
 * lets a later rewrite leak into draws issued before it, so cascades render with another
 * cascade's instance list: diagonal garbage stripes that change every frame. Re-specifying the
 * texture (texImage2D) on each upload gives every write fresh storage. It's a 64 KB texture
 * uploaded a few times per frame, so the cost is negligible.
 *
 * Must run before the renderer is created: pixi merges uploader extensions at construction.
 */
export function installInstanceIndexUploadFix(): void {
  const uploader: GLTextureUploader = {
    id: "buffer",
    upload(source, glTexture, gl, webGLVersion, targetOverride, forceAllocation) {
      const realloc = forceAllocation || source.label === "InstanceIndex";
      glUploadBufferImageResource.upload(source, glTexture, gl, webGLVersion, targetOverride, realloc);
    },
  };
  extensions.add({ type: ExtensionType.TextureUploaderWebGL, name: "buffer", ref: uploader });
}
