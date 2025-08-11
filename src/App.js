import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 청소년지도사 면접 대비 웹앱 (단일 파일 React)
 * - 데이터: 업로드한 Markdown/CSV에서 자동 파싱 + 수동 JSON/CSV 업로드 지원
 * - 기능: 문제 TTS, 음성 답변(STT), 자동 채점(키워드/유사도/길이/말버릇), 모범답안 음성
 */

// ===== 채점 유틸 =====
const tokenize = (text) => (text || '').toLowerCase().replace(/[^가-힣a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const unique = (arr) => Array.from(new Set(arr));
function jaccard(a, b){const A=new Set(a),B=new Set(b);let inter=0;for(const x of A) if(B.has(x)) inter++;const u=A.size+B.size-inter;return u===0?0:inter/u;}
function keywordCoverage(answerTokens, keywords){if(!keywords||!keywords.length) return 0;const K=new Set(keywords.map(k=>k.toLowerCase()));const A=new Set(answerTokens);let hit=0;for(const k of K) if(A.has(k)) hit++;return hit/K.size;}
function lengthScore(answerTokens,min=80,max=220){const n=answerTokens.length;if(n<=0)return 0;if(n<min)return n/min*0.8;if(n>max)return Math.max(0,1-(n-max)/max)*0.9;return 1;}
function fillerPenalty(answer){const fillers=['어','음','그','그러니까','뭐랄까','약간','있거든요','같습니다만'];const c=fillers.reduce((acc,f)=>acc+(answer.split(f).length-1),0);return Math.min(0.15,c*0.02);} 
function scoreAnswer(userText, modelAnswer, keywords){const a=tokenize(userText), r=tokenize(modelAnswer);const sim=jaccard(a,r);const cov=keywordCoverage(a,keywords);const len=lengthScore(a);const pen=fillerPenalty(userText);const raw=0.45*cov+0.35*sim+0.20*len;return Math.round(Math.max(0,raw-pen)*100);} 

// ===== TTS/STT =====
const getKoreanVoice=()=>{const s=window.speechSynthesis;if(!s)return null;const v=s.getVoices();const ko=v.find(x=>/ko-KR/i.test(x.lang));return ko||v[0]||null;};
function speak(text,opts){opts=opts||{};if(!window.speechSynthesis)return;const msg=new SpeechSynthesisUtterance(text);const voice=getKoreanVoice();if(voice) msg.voice=voice;msg.lang=(voice&&voice.lang)||'ko-KR';msg.rate=opts.rate||1;msg.pitch=opts.pitch||1;msg.volume=opts.volume||1;window.speechSynthesis.cancel();window.speechSynthesis.speak(msg);} 
function useSpeechRecognition(cfg){cfg=cfg||{};const lang=cfg.lang||'ko-KR';const interim=cfg.interimResults!==undefined?cfg.interimResults:true;const [supported,setSupported]=useState(false);const [listening,setListening]=useState(false);const [transcript,setTranscript]=useState('');const recRef=useRef(null);useEffect(()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(SR){setSupported(true);recRef.current=new SR();recRef.current.lang=lang;recRef.current.interimResults=interim;recRef.current.continuous=true;recRef.current.onresult=(e)=>{let t='';for(let i=e.resultIndex;i<e.results.length;i++){t+=e.results[i][0].transcript;}setTranscript(function(prev){return prev+t;});};recRef.current.onend=function(){setListening(false);};}},[lang,interim]);const start=()=>{if(!recRef.current)return;setTranscript('');try{recRef.current.start();setListening(true);}catch(e){}};const stop=()=>{if(!recRef.current)return;try{recRef.current.stop();}catch(e){}setListening(false);};return {supported,listening,transcript,setTranscript,start,stop};}

// ===== Markdown/CSV 파서 =====
function parseMarkdownToBank(md){const lines=md.split(/\r?\n/);const items=[];let cur=null;function push(){if(cur){cur.modelAnswer=(cur.modelAnswer||'').trim();if(!cur.keywords||!cur.keywords.length){cur.keywords=guessKeywords(cur);}items.push(cur);cur=null;}}const qRe=/^\s*-\s*문\d{2}-\d{3}\s+(.+?)\??\s*$/;for(let i=0;i<lines.length;i++){const line=lines[i];const m=line.match(qRe);if(m){push();const prompt=m[1].replace(/\*\*|__/g,'').trim();cur={id:'MD-'+(items.length+1),year:undefined,subject:'기출',prompt:prompt,keywords:[],modelAnswer:'',difficulty:'중'};continue;}if(!cur)continue;if(/^\s*-\s*문\d{2}-\d{3}\s+/.test(line)||/^##\s+/.test(line)){push();i-=1;continue;}if(/\*\*(.+?)\*\*/.test(line)){const bolds=Array.from(line.matchAll(/\*\*(.+?)\*\*/g)).map(x=>x[1]);cur.keywords=unique([].concat(cur.keywords||[],bolds.map(function(b){return b.replace(/[^가-힣a-z0-9]/gi,'').toLowerCase();}).filter(Boolean)));}cur.modelAnswer+=(cur.modelAnswer?'\n':'')+line;}push();return items.map(function(it){return Object.assign({},it,{modelAnswer:it.modelAnswer.replace(/^\s*[-*]\s*/gm,'').replace(/^>\s*/gm,'').trim()});});}
function guessKeywords(q){const t=(q.prompt||'')+' '+(q.modelAnswer||'');const toks=tokenize(t).filter(function(w){return w.length>=2;});const freq=new Map();for(const w of toks){freq.set(w,(freq.get(w)||0)+1);}return Array.from(freq.entries()).sort(function(a,b){return b[1]-a[1];}).slice(0,6).map(function(x){return x[0];});}
function parseCSV(text){const lines=text.replace(/\r\n?/g,'\n').split('\n').filter(Boolean);if(lines.length===0)return[];const headers=lines[0].split(',').map(function(h){return h.trim();});const idx=(name)=>headers.findIndex(x=>x===name);const need=['id','subject','prompt','modelAnswer'];for(const n of need){if(idx(n)===-1) throw new Error(n+' 헤더 필요');}const rows=[];function smartSplit(line,expected){const out=[];let cur='';let quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++;}else{quoted=!quoted;}}else if(ch===','&&!quoted){out.push(cur);cur='';}else{cur+=ch;}}out.push(cur);while(out.length<expected)out.push('');return out.map(function(s){return s.trim();});}for(let i=1;i<lines.length;i++){const row=smartSplit(lines[i],headers.length);const item={id:row[idx('id')],subject:row[idx('subject')],prompt:row[idx('prompt')],modelAnswer:row[idx('modelAnswer')]};const y=idx('year'),k=idx('keywords'),d=idx('difficulty');if(y!==-1&&row[y]) item.year=Number(row[y])||undefined; if(k!==-1&&row[k]) item.keywords=row[k].split(/;|,|\s+/).filter(Boolean); if(d!==-1&&row[d]) item.difficulty=row[d]; rows.push(item);}return rows;}

// ===== 메인 앱 =====
export default function InterviewTrainer(){
  const [bank,setBank]=useState([]);
  const [mode,setMode]=useState('기출 모드');
  const [subjectFilter,setSubjectFilter]=useState('전체');
  const [current,setCurrent]=useState(null);
  const [score,setScore]=useState(null);
  const [explain,setExplain]=useState('');
  const [prepSec,setPrepSec]=useState(10);
  const [answerSec,setAnswerSec]=useState(90);
  const [timeLeft,setTimeLeft]=useState(0);
  const [phase,setPhase]=useState('idle');
  const [resultLog,setResultLog]=useState([]);
  const [jsonOpen,setJsonOpen]=useState(false);

  const subjects=useMemo(function(){return ['전체'].concat(unique((bank||[]).map(function(b){return b.subject||'기출';})));},[bank]);
  const sr=useSpeechRecognition({lang:'ko-KR',interimResults:true});

  useEffect(function(){
    const path='/mnt/data/청소년지도사 2급 면접시험대비 192a1b0ed9dd498d8af3c6799e56a716.md';
    fetch(path).then(function(r){return r.ok?r.text():Promise.reject(new Error('fetch fail'));}).then(function(txt){const parsed=parseMarkdownToBank(txt);if(parsed.length) setBank(parsed);}).catch(function(){});
  },[]);

  useEffect(function(){
    if(phase==='prep'||phase==='answer'){
      if(timeLeft<=0){
        if(phase==='prep'){setPhase('answer');setTimeLeft(answerSec);sr.start();}
        else{sr.stop();setPhase('done');}
        return;
      }
      const t=setTimeout(function(){setTimeLeft(function(s){return s-1;});},1000);
      return function(){clearTimeout(t);};
    }
  },[phase,timeLeft,answerSec]);

  const filtered=useMemo(function(){return (bank||[]).filter(function(q){return subjectFilter==='전체'?true:q.subject===subjectFilter;}).slice(0,9999);},[bank,subjectFilter]);

  function pickQuestion(){if(!filtered.length)return;const q=filtered[Math.floor(Math.random()*filtered.length)];setCurrent(q);setScore(null);setExplain('');setPhase('prep');setTimeLeft(prepSec);sr.setTranscript('');speak('문제를 안내합니다. 준비 시간 후 답변을 시작하세요. 질문:'+q.prompt);} 
  function gradeNow(){if(!current)return;const userText=sr.transcript;const s=scoreAnswer(userText,current.modelAnswer||'',current.keywords||[]);setScore(s);const ans=tokenize(userText);const cov=keywordCoverage(ans,current.keywords||[]);const sim=jaccard(ans,tokenize(current.modelAnswer||''));const len=lengthScore(ans);const pen=fillerPenalty(userText);setExplain('키워드 '+Math.round(cov*100)+'%, 유사도 '+Math.round(sim*100)+'%, 길이 '+Math.round(len*100)+'%, 말버릇 감점 '+Math.round(pen*100)+'%');setResultLog(function(prev){return [{ts:new Date().toISOString(),id:current.id,subject:current.subject,prompt:current.prompt,userAnswer:userText,score:s}].concat(prev);});}
  function speakAnswer(){if(!current)return;speak('모범 답변:'+ (current.modelAnswer||'준비된 모범답안이 없습니다.'));}
  function exportCSV(){const headers=['시간','문항ID','과목','질문','나의답변','점수'];const lines=[headers.join(',')].concat(resultLog.map(function(r){return [r.ts,r.id,r.subject,quote(r.prompt),quote(r.userAnswer),r.score].join(',');}));const blob=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='면접연습_결과.csv';a.click();URL.revokeObjectURL(url);} 
  const quote=(t)=>'"'+(String(t||'').replaceAll('"','""'))+'"';

  async function onUploadMarkdown(file){const txt=await file.text();const arr=parseMarkdownToBank(txt);if(arr.length) setBank(arr);} 
  async function onUploadCSV(file){const txt=await file.text();const arr=parseCSV(txt);if(arr.length) setBank(arr);} 

  return (
    <div className='min-h-screen bg-gray-50 text-gray-900'>
      <header className='sticky top-0 z-10 bg-white/80 backdrop-blur border-b'>
        <div className='max-w-6xl mx-auto px-4 py-3 flex items-center justify-between'>
          <h1 className='text-xl md:text-2xl font-bold'>청소년지도사 면접 대비 스피킹 트레이너</h1>
          <div className='flex items-center gap-2 text-sm'>
            <ModeTabs mode={mode} setMode={setMode} />
            <button onClick={function(){setJsonOpen(true);}} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100'>문제은행</button>
          </div>
        </div>
      </header>

      <main className='max-w-6xl mx-auto px-4 py-6 grid md:grid-cols-12 gap-6'>
        <section className='md:col-span-5 lg:col-span-4'>
          <div className='bg-white rounded-2xl shadow p-4 space-y-4'>
            <h2 className='font-semibold text-lg'>데이터 불러오기</h2>
            <div className='grid gap-2 text-sm'>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>Markdown 업로드 (노션 Export .md)</span>
                <input type='file' accept='.md,.markdown,.txt' onChange={function(e){if(e.target.files&&e.target.files[0]) onUploadMarkdown(e.target.files[0]);}} />
              </label>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>CSV 업로드</span>
                <input type='file' accept='.csv' onChange={function(e){if(e.target.files&&e.target.files[0]) onUploadCSV(e.target.files[0]);}} />
              </label>
              <p className='text-xs text-gray-500'>* 업로드 시 기존 문제은행을 대체합니다. 필요하면 [문제은행]에서 JSON으로도 편집/붙여넣기 가능합니다.</p>
            </div>
          </div>

          <div className='bg-white rounded-2xl shadow p-4 space-y-4 mt-4'>
            <h2 className='font-semibold text-lg'>훈련 설정</h2>
            <div className='grid grid-cols-2 gap-3 text-sm'>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>모드</span>
                <select className='border rounded-xl px-3 py-2' value={mode} onChange={function(e){setMode(e.target.value);}}>
                  <option>기출 모드</option>
                  <option>과목별 모드</option>
                  <option>모의면접 세트</option>
                </select>
              </label>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>과목</span>
                <select className='border rounded-xl px-3 py-2' value={subjectFilter} onChange={function(e){setSubjectFilter(e.target.value);}}>
                  {subjects.map(function(s){return <option key={s}>{s}</option>;})}
                </select>
              </label>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>준비 시간(초)</span>
                <input type='number' min={0} className='border rounded-xl px-3 py-2' value={prepSec} onChange={function(e){setPrepSec(parseInt(e.target.value||0));}} />
              </label>
              <label className='flex flex-col gap-1'>
                <span className='text-gray-600'>답변 시간(초)</span>
                <input type='number' min={10} className='border rounded-xl px-3 py-2' value={answerSec} onChange={function(e){setAnswerSec(parseInt(e.target.value||0));}} />
              </label>
            </div>
            <button onClick={pickQuestion} disabled={!filtered.length} className='w-full py-3 rounded-2xl bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:bg-gray-300'>새 문제 출제</button>
            <div className='text-xs text-gray-600'>{filtered.length?('문항 '+filtered.length+'개 로드됨'):'문제 데이터를 먼저 불러오세요.'}</div>
          </div>

          <div className='bg-white rounded-2xl shadow p-4 mt-4 space-y-3'>
            <h3 className='font-semibold'>세션 결과</h3>
            <div className='flex items-center gap-2'>
              <button onClick={exportCSV} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>CSV 다운로드</button>
              <button onClick={function(){setResultLog([]);}} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>기록 초기화</button>
            </div>
            <ul className='max-h-60 overflow-auto divide-y'>
              {resultLog.map(function(r,i){return (
                <li key={i} className='py-2 text-sm'>
                  <div className='flex items-center justify-between'>
                    <span className='font-medium'>{r.subject||'-'}</span>
                    <span className='text-gray-500'>{new Date(r.ts).toLocaleString()}</span>
                  </div>
                  <div className='truncate text-gray-700'>{r.prompt}</div>
                  <div className='text-indigo-700 font-semibold'>점수: {r.score}</div>
                </li>
              );})}
            </ul>
          </div>
        </section>

        <section className='md:col-span-7 lg:col-span-8'>
          <div className='bg-white rounded-2xl shadow p-4 space-y-4'>
            <div className='flex items-center justify-between'>
              <h2 className='font-semibold text-lg'>문제 & 답변</h2>
              <TimerBadge phase={phase} timeLeft={timeLeft} />
            </div>

            {current? (
              <div className='space-y-4'>
                <div className='p-4 bg-gray-50 rounded-2xl'>
                  <div className='text-sm text-gray-600'>[{current.subject||'-'}]</div>
                  <div className='mt-1 text-lg font-medium'>{current.prompt}</div>
                  <div className='mt-2 flex gap-2'>
                    <button onClick={function(){speak(current.prompt);}} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>문제 음성</button>
                    <button onClick={speakAnswer} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>모범답안 음성</button>
                  </div>
                </div>

                <AnswerPanel sr={sr} onGrade={gradeNow} score={score} explain={explain} />

                <details className='rounded-2xl border p-4'>
                  <summary className='cursor-pointer font-semibold'>모범 답변(텍스트 보기)</summary>
                  <p className='mt-2 whitespace-pre-wrap text-sm text-gray-800'>{current.modelAnswer||'(모범답안 없음)'}</p>
                  {current.keywords&&current.keywords.length? (<p className='mt-2 text-xs text-gray-600'>키워드: {current.keywords.join(', ')}</p>) : null}
                </details>
              </div>
            ) : (
              <div className='text-gray-600'>좌측에서 "새 문제 출제"를 눌러 시작하세요.</div>
            )}
          </div>

          <div className='bg-white rounded-2xl shadow p-4 mt-4'>
            <h3 className='font-semibold mb-2'>문제 미리보기 ({filtered.length}문항)</h3>
            <div className='grid gap-2 max-h-64 overflow-auto'>
              {filtered.map(function(q){return (
                <button key={q.id} onClick={function(){setCurrent(q);setPhase('prep');setTimeLeft(prepSec);sr.setTranscript('');speak('질문:'+q.prompt);}} className='text-left p-3 rounded-xl border hover:bg-gray-50'>
                  <div className='text-xs text-gray-500'>[{q.subject||'-'}]</div>
                  <div className='text-sm'>{q.prompt}</div>
                </button>
              );})}
            </div>
          </div>
        </section>
      </main>

      {jsonOpen && (
        <BankEditor bank={bank} onClose={function(){setJsonOpen(false);}} onSave={function(jsonText){try{const arr=JSON.parse(jsonText);setBank(arr);alert('문제은행 반영 완료');}catch(e){alert('JSON 오류: '+e.message);}}} />
      )}

      <footer className='max-w-6xl mx-auto px-4 py-10 text-sm text-gray-500'>
        <h4 className='font-semibold text-gray-700 mb-2'>사용 팁</h4>
        <ul className='list-disc list-inside space-y-1'>
          <li>Chrome 권장, 마이크 권한 허용 후 사용하세요.</li>
          <li>준비·답변 타이머 자동 진행. 준비 종료 시 자동 녹음 시작.</li>
          <li>채점: 키워드/유사도/길이/말버릇 감점 종합 100점.</li>
          <li>문제은행은 Markdown/CSV 업로드 또는 JSON 편집으로 교체 가능합니다.</li>
        </ul>
      </footer>
    </div>
  );
}

function ModeTabs(props){const mode=props.mode,setMode=props.setMode;const tabs=['기출 모드','과목별 모드','모의면접 세트'];return (<div className='inline-flex rounded-2xl border p-1 bg-white'>{tabs.map(function(t){return (<button key={t} onClick={function(){setMode(t);}} className={'px-3 py-1.5 rounded-xl text-sm '+(mode===t?'bg-gray-900 text-white':'hover:bg-gray-100')}>{t}</button>);})}</div>);} 
function TimerBadge(props){const phase=props.phase,timeLeft=props.timeLeft;const label=phase==='prep'?'준비':(phase==='answer'?'답변':(phase==='done'?'종료':'대기'));return (<div className={'px-3 py-1.5 rounded-full text-sm border '+(phase==='answer'?'bg-green-50 border-green-300 text-green-800':(phase==='prep'?'bg-amber-50 border-amber-300 text-amber-800':(phase==='done'?'bg-gray-100 border-gray-300 text-gray-600':'bg-white')))}>{label} {(phase==='prep'||phase==='answer')?('· '+timeLeft+'s'):''}</div>);} 
function AnswerPanel(props){const sr=props.sr,onGrade=props.onGrade,score=props.score,explain=props.explain;return (<div className='space-y-2'>
  <div className='flex items-center gap-2'>
    <button onClick={sr.start} disabled={!sr.supported||sr.listening} className='px-3 py-2 rounded-2xl border hover:bg-gray-100 text-sm disabled:opacity-50'>🎙️ 녹음 시작</button>
    <button onClick={sr.stop} disabled={!sr.supported||!sr.listening} className='px-3 py-2 rounded-2xl border hover:bg-gray-100 text-sm disabled:opacity-50'>⏹️ 중지</button>
    <button onClick={function(){sr.setTranscript('');}} className='px-3 py-2 rounded-2xl border hover:bg-gray-100 text-sm'>🧹 지우기</button>
    <button onClick={onGrade} className='ml-auto px-4 py-2 rounded-2xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700'>채점하기</button>
  </div>
  <textarea className='w-full h-48 md:h-56 border rounded-2xl p-3 text-sm' placeholder='여기에 인식된 답변이 표시됩니다. (수정 가능)' value={sr.transcript} onChange={function(e){sr.setTranscript(e.target.value);}} />
  {score!==null && (
    <div className='p-4 rounded-2xl bg-indigo-50 border border-indigo-200'>
      <div className='font-semibold text-indigo-800'>적합도 점수: {score} / 100</div>
      <div className='text-sm text-indigo-900 mt-1'>{explain}</div>
      <div className='mt-2 text-sm text-gray-700'><b>팁:</b> 핵심 용어→근거→사례→현장 적용 순서로 90초 내 구조화하세요.</div>
    </div>
  )}
</div>);} 
function BankEditor(props){const bank=props.bank,onSave=props.onSave,onClose=props.onClose;const [text,setText]=useState(JSON.stringify(bank||[],null,2));const fileRef=useRef(null);async function onPickCSV(e){const file=e.target.files&&e.target.files[0];if(!file)return;const txt=await file.text();try{const arr=parseCSV(txt);setText(JSON.stringify(arr,null,2));alert('CSV에서 '+arr.length+'개 항목을 변환했습니다. 저장을 눌러 반영하세요.');}catch(err){alert('CSV 파싱 오류: '+err.message);}finally{e.target.value='';}}return (<div className='fixed inset-0 bg-black/30 flex items-center justify-center p-4'>
  <div className='bg-white max-w-4xl w-full rounded-2xl shadow-xl p-4'>
    <div className='flex items-center justify-between mb-2'>
      <h3 className='font-semibold'>문제은행(JSON / CSV)</h3>
      <div className='flex gap-2'>
        <label className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm cursor-pointer'>CSV 불러오기
          <input ref={fileRef} onChange={onPickCSV} type='file' accept='.csv' className='hidden' />
        </label>
        <button onClick={function(){onSave(text);}} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>저장</button>
        <button onClick={onClose} className='px-3 py-1.5 rounded-xl border hover:bg-gray-100 text-sm'>닫기</button>
      </div>
    </div>
    <textarea className='w-full h-[60vh] border rounded-2xl p-3 text-xs font-mono' value={text} onChange={function(e){setText(e.target.value);}} />
    <div className='mt-2 text-xs text-gray-600 space-y-1'>
      <p>CSV 헤더 예시: <code>id,year,subject,prompt,keywords,modelAnswer,difficulty</code></p>
      <p>keywords는 세미콜론(;) 또는 쉼표(,)로 구분합니다. 저장을 누르면 JSON으로 반영됩니다.</p>
    </div>
  </div>
</div>);}