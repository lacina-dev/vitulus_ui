const btns = document.querySelectorAll('button[id^=btn]')

btns.forEach(btn => {
   btn.addEventListener('click', event => {
       setTimeout(function () {        
           btn.blur();
           btn.classList.remove("active");
        }, 700);
   });
});


