import { useEffect, useRef } from "react";
import { BACK, FRONT, VERTEX } from "./shaders";

const SCALE = 0.25; // one shader pixel = 4 CSS pixels
const FRAME_MS = 33; // about 30 frames per second

type Draw = (time: number) => void;

function makeLayer(canvas: HTMLCanvasElement, fragment: string): Draw | null {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(prog, "r");
  const uT = gl.getUniformLocation(prog, "t");
  return (time) => {
    const w = Math.max(1, Math.round(innerWidth * SCALE));
    const h = Math.max(1, Math.round(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uR, w, h);
    gl.uniform1f(uT, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

/**
 * Two full-screen WebGL layers: moon, fog and embers behind the panels; ground fog,
 * vignette and bats over them. With "reduce motion", one still frame. Without
 * WebGL, nothing.
 */
export function Effects() {
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!backRef.current || !frontRef.current) return;
    const layers = [makeLayer(backRef.current, BACK), makeLayer(frontRef.current, FRONT)].filter(
      (l): l is Draw => l !== null,
    );
    const draw = (time: number) => {
      for (const l of layers) l(time);
    };

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const still = () => draw(12);
      still();
      addEventListener("resize", still);
      return () => removeEventListener("resize", still);
    }

    let raf = 0;
    let last = 0;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || ms - last < FRAME_MS) return;
      last = ms;
      draw(ms / 1000);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <canvas ref={backRef} className="fx fx--back" aria-hidden="true" />
      <canvas ref={frontRef} className="fx fx--front" aria-hidden="true" />
    </>
  );
}
