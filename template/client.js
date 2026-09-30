
(function(){
  var tabs=document.querySelectorAll("nav.tabs button"), views=document.querySelectorAll(".view");
  function show(v){tabs.forEach(function(b){b.classList.toggle("active",b.dataset.view===v)});views.forEach(function(s){s.classList.toggle("active",s.id==="view-"+v)});}
  // JS on: collapse to tabbed mode (no-JS shows all sections stacked)
  views.forEach(function(s){ if(s.id!=="view-timeline") s.classList.remove("active"); });
  tabs.forEach(function(b){ b.addEventListener("click",function(){ show(b.dataset.view); }); });
  document.querySelectorAll("[data-evlink]").forEach(function(el){
    el.addEventListener("click",function(e){
      var id=el.getAttribute("data-evlink");
      show("evidence");
      var t=document.getElementById(id);
      if(t){ e.preventDefault(); t.scrollIntoView(); }
    });
  });
  var q=document.getElementById("q"), df=document.getElementById("dfrom"), dt=document.getElementById("dto"), count=document.getElementById("count");
  var type="all";
  document.querySelectorAll("#typepills .pill").forEach(function(p){
    p.addEventListener("click",function(){
      document.querySelectorAll("#typepills .pill").forEach(function(x){x.classList.remove("on")});
      p.classList.add("on"); type=p.dataset.t; apply();
    });
  });
  function apply(){
    var qw=(q.value||"").toLowerCase().split(/\s+/).filter(Boolean);
    var from=df.value, to=dt.value, n=0, total=0;
    document.querySelectorAll("#timeline .event").forEach(function(card){
      total++;
      var ok=true, d=card.dataset;
      if(type!=="all"){
        if(type==="allegation"){ if(d.label!=="allegation") ok=false; }
        else if(d.type!==type) ok=false;
      }
      if(ok&&from&&(!d.date||d.date<from)) ok=false;
      if(ok&&to&&(!d.date||d.date>to)) ok=false;
      if(ok&&qw.length){ var hay=d.hay||""; for(var i=0;i<qw.length;i++){ if(hay.indexOf(qw[i])<0){ ok=false; break; } } }
      card.style.display=ok?"":"none";
      if(ok) n++;
    });
    count.textContent=n+" of "+total+" events";
    document.querySelectorAll("#timeline .era").forEach(function(era){
      var vis=era.querySelectorAll('.event:not([style*="none"])').length;
      era.style.display=vis?"":"none";
    });
  }
  q.addEventListener("input",apply); df.addEventListener("change",apply); dt.addEventListener("change",apply);
  count.textContent=document.querySelectorAll("#timeline .event").length+" events";
})();
