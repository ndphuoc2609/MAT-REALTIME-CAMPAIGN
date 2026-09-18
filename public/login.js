const form=document.querySelector('#loginForm');
const errorBox=document.querySelector('#loginError');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  errorBox.textContent='';
  const button=document.querySelector('#submit');
  button.disabled=true;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'Sign in failed.');
    window.location.href='/';
  }catch(error){errorBox.textContent=error.message;}
  finally{button.disabled=false;}
});
