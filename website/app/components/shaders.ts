// Fragment shaders for the two full-screen layers (WebGL 1, GLSL ES 1.0).
// Both draw at 1/4 resolution: one shader pixel is 4 CSS pixels, the "art pixel"
// of the design system.

export const VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

const COMMON = `precision mediump float;
uniform vec2 r;uniform float t;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int k=0;k<4;k++){v+=a*n(p);p*=2.03;a*=.5;}return v;}
`;

/** Behind the panels: night sky, a pixel moon, rising fog, embers. */
export const BACK =
  COMMON +
  `void main(){
vec2 px=floor(gl_FragCoord.xy);vec2 uv=gl_FragCoord.xy/r;vec2 q=vec2(uv.x*r.x/r.y,uv.y);
vec3 col=vec3(.047,0.,.075);
vec2 mc=vec2(floor(r.x*.6),r.y-15.);float R=9.;float d=length(px-mc);
col+=vec3(1.,.85,.55)*exp(-max(d-R,0.)/5.)*.22;
if(d<R){float cr=step(.62,n(px*.45+3.));col=mix(vec3(1.,.93,.75),vec3(.82,.74,.6),cr);
if(d>R-1.)col*=.85;}
float f=fbm(q*2.5+vec2(t*.02,-t*.035));f=fbm(q*2.+f*1.5+vec2(-t*.015,t*.01));
float low=smoothstep(.7,0.,uv.y);
col=mix(col,mix(vec3(.32,.18,.36),vec3(.3,.45,.33),f),f*f*low*.55);
vec2 g=q*16.;g.y-=t*.4;g.x+=sin(g.y*.3+t*.2)*.4;
vec2 id=floor(g);float s=h(id);
if(s>.965){vec2 o=(vec2(h(id+1.),h(id+2.))-.5)*.5;vec2 e2=abs(fract(g)-.5-o);
col+=vec3(1.,.52,0.)*step(max(e2.x,e2.y),.07)*(.5+.5*sin(t*2.+s*60.))*(.3+.7*low);}
gl_FragColor=vec4(col,1.);}`;

/**
 * Over the panels (pointer events off): a soft vignette, ground fog lit by candle
 * light, and three pixel bats that fly across now and then. Each bat is a 13x6
 * bitmap; each row is one number, one bit per pixel. Two frames: wings up, wings down.
 */
export const FRONT =
  COMMON +
  `
float row(float y,float up){
if(up>.5){if(y<.5)return 4097.;if(y<1.5)return 6147.;if(y<2.5)return 7335.;if(y<3.5)return 4094.;if(y<4.5)return 2044.;return 224.;}
if(y<.5)return 160.;if(y<1.5)return 496.;if(y<2.5)return 2044.;if(y<3.5)return 4094.;if(y<4.5)return 7399.;return 4097.;}
void over(inout vec4 o,vec3 c,float a){o=vec4(c*a+o.rgb*(1.-a),a+o.a*(1.-a));}
void main(){
vec2 px=floor(gl_FragCoord.xy);vec2 uv=gl_FragCoord.xy/r;
vec4 o=vec4(0.);
float v=smoothstep(.62,1.2,length((uv-.5)*vec2(1.,1.1))*1.35);
over(o,vec3(.03,0.,.05),v*.45);
float candle=.8+.2*n(vec2(t*2.,1.));
float f=fbm(vec2(uv.x*5.+t*.06,uv.y*9.-t*.03));
float fa=smoothstep(.13,0.,uv.y)*f*.7;
vec3 fc=mix(vec3(.45,.3,.55),vec3(1.,.5,.1)*candle,smoothstep(.06,0.,uv.y)*.5);
over(o,fc,fa);
for(int i=0;i<3;i++){
float fi=float(i);float P=19.+fi*8.;float ph=fract(t/P+fi*.37);
if(ph<.4){float k=ph/.4;float x=mix(-20.,r.x+20.,k);if(i==1)x=r.x-x;
float y=r.y*(.3+.5*h(vec2(fi,floor(t/P+fi*.37))))+sin(t*3.+fi)*4.;
vec2 b=px-floor(vec2(x,y));
if(b.x>=0.&&b.x<13.&&b.y>=0.&&b.y<6.){
float up=mod(floor(t*7.+fi),2.);float ry=5.-b.y;float bx=b.x;
float bit=mod(floor(row(ry,up)/pow(2.,12.-bx)),2.);
if(bit>.5){bool eye=ry>2.5&&ry<3.5&&(bx>4.5&&bx<5.5||bx>6.5&&bx<7.5);
over(o,eye?vec3(1.,.52,0.):vec3(.02,0.,.03),eye?1.:.95);}}}}
gl_FragColor=o;}`;
