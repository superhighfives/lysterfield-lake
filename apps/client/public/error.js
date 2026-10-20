// The error pages' few behaviours (see error.css): fireflies scattered
// about, and the print tilting toward the pointer. The theme is applied
// inline in each page's head, before first paint.
;(function () {
  var flies = document.querySelector('.fireflies')
  if (flies) {
    for (var i = 0; i < 18; i++) {
      var fly = document.createElement('i')
      fly.style.setProperty('--x', Math.random() * 100 + '%')
      fly.style.setProperty('--y', Math.random() * 100 + '%')
      fly.style.setProperty('--d', 5 + Math.random() * 7 + 's')
      fly.style.setProperty('--s', 2 + Math.random() * 3 + 'px')
      fly.style.animationDelay = -Math.random() * 10 + 's'
      flies.appendChild(fly)
    }
  }

  var print = document.querySelector('.error__print')
  if (print && window.matchMedia('(hover: hover)').matches) {
    window.addEventListener('pointermove', function (event) {
      var x = event.clientX / window.innerWidth - 0.5
      var y = event.clientY / window.innerHeight - 0.5
      print.style.setProperty('--ty', x * 14 + 'deg')
      print.style.setProperty('--tx', -y * 14 + 'deg')
    })
  }
})()
